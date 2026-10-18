import * as p from '@clack/prompts';
import pc from 'picocolors';
import { sanitizeMetadata } from './sanitize.ts';
import { getOwnerRepo } from './source-parser.ts';
import { fetchAuditData } from './telemetry.ts';
import type { AgentType } from './types.ts';
import { agents } from './agents.ts';
import {
  buildSecurityLines,
  buildSkillSummaryLines,
  errorMessage,
  ensureUniversalAgents,
  InstallationCancelled,
  installToTargets,
  installWellKnownToTargets,
  persistDiskInstallation,
  persistWellKnownInstallation,
  selectInstallSettings,
  targetKey,
  type AddOptions,
  type InstallSettings,
  type TargetInstallResult,
} from './add.ts';
import { InstallCompletion, installationReason } from './personal-history.ts';
import { detectAgent, getAgentType } from './detect-agent.ts';
import { chooseSkills, savedSkills, runSavedList, formatSavedSource } from './saved-skills.ts';
import { personalSkillKey, deduplicateSkills, type SkillLocator } from './personal-catalog.ts';
import { prepareSource, type PreparedSkill, type PreparedSource } from './add-source.ts';

interface SessionSkillResult {
  locator: SkillLocator;
  complete: boolean;
  results: TargetInstallResult[];
  error?: string;
}

interface PreparedSelection {
  sources: Map<string, PreparedSource>;
  errors: Map<string, string>;
}

async function prepareSelection(
  locators: SkillLocator[],
  options: AddOptions,
  prepared: PreparedSelection
): Promise<void> {
  for (const source of new Set(locators.map((locator) => locator.installSource))) {
    const requested = locators.filter((locator) => locator.installSource === source);
    const previous = prepared.sources.get(source);
    if (
      previous &&
      requested.every((locator) =>
        previous.entries.some(
          (entry) => personalSkillKey(entry.locator) === personalSkillKey(locator)
        )
      )
    )
      continue;
    try {
      const names = requested.map((locator) => locator.name);
      prepared.sources.set(source, await prepareSource(source, { ...options, skill: names }));
      prepared.errors.delete(source);
      await previous?.cleanup();
    } catch (error) {
      if (error instanceof InstallationCancelled) throw error;
      prepared.errors.set(source, errorMessage(error));
    }
  }
}

function selectedEntries(locators: SkillLocator[], prepared: PreparedSelection): PreparedSkill[] {
  return locators.flatMap((locator) => {
    const source = prepared.sources.get(locator.installSource);
    const entry = source?.entries.find(
      (entry) => personalSkillKey(entry.locator) === personalSkillKey(locator)
    );
    return entry ? [entry] : [];
  });
}

class InstallSession {
  private completion = new InstallCompletion();
  private closed = false;
  readonly locators: SkillLocator[];
  readonly settings: InstallSettings;
  private readonly options: AddOptions;
  readonly prepared: PreparedSelection;

  constructor(
    locators: SkillLocator[],
    settings: InstallSettings,
    options: AddOptions,
    prepared: PreparedSelection
  ) {
    this.locators = locators;
    this.settings = settings;
    this.options = options;
    this.prepared = prepared;
  }

  entries(): PreparedSkill[] {
    return selectedEntries(this.locators, this.prepared);
  }

  preparationErrors(): string[] {
    return this.locators
      .flatMap((locator) => {
        const error = this.prepared.errors.get(locator.installSource);
        if (error) return [`${locator.installSource}: ${error}`];
        const source = this.prepared.sources.get(locator.installSource);
        return source?.entries.some(
          (entry) => personalSkillKey(entry.locator) === personalSkillKey(locator)
        )
          ? []
          : [`${locator.installSource}: skill ${locator.name} was not found`];
      })
      .filter((value, index, all) => all.indexOf(value) === index);
  }

  async install(): Promise<SessionSkillResult[]> {
    if (this.closed) throw new Error('Installation session is closed.');
    const { installTargets, installGlobally, installMode, explicitlySelectedAgents } =
      this.settings;
    for (const source of this.prepared.sources.values()) {
      const entries = this.entries().filter((entry) => source.entries.includes(entry));
      const attempted: TargetInstallResult[] = [];
      for (const entry of entries) {
        const previous = this.completion.results(entry.locator);
        const pending = installTargets.filter(
          (target) =>
            !previous.some(
              (result) => targetKey(result.target) === targetKey(target) && result.success
            )
        );
        if (pending.length === 0) continue;
        const results =
          entry.kind === 'disk' && source.kind === 'disk'
            ? await installToTargets(source.resolved, [entry.skill], pending, {
                global: installGlobally,
                mode: installMode,
                createMissingAgentRoot: (agent) => explicitlySelectedAgents.has(agent),
                continueOnError: true,
              })
            : entry.kind === 'well-known'
              ? await installWellKnownToTargets([entry.skill], pending, {
                  global: installGlobally,
                  mode: installMode,
                  continueOnError: true,
                })
              : [];
        attempted.push(...results);
        await this.completion.record(
          entry.locator,
          installTargets,
          results,
          installationReason(this.options.reason)
        );
      }
      if (attempted.length === 0) continue;
      try {
        if (source.kind === 'disk') {
          const skills = entries.flatMap((entry) => (entry.kind === 'disk' ? [entry.skill] : []));
          await persistDiskInstallation(
            source.resolved,
            source.parsed,
            skills,
            attempted,
            this.settings,
            this.options,
            { directDownload: source.directDownload, privacy: source.privacy }
          );
        } else {
          const skills = entries.flatMap((entry) =>
            entry.kind === 'well-known' ? [entry.skill] : []
          );
          await persistWellKnownInstallation(
            source.parsed.url,
            skills,
            attempted,
            this.settings,
            this.options
          );
        }
      } catch (error) {
        console.error(
          `Could not save installation metadata for ${source.installSource}: ${errorMessage(error)}`
        );
      }
    }
    return this.report();
  }

  report(): SessionSkillResult[] {
    return this.locators.map((locator) => {
      const results = this.completion.results(locator);
      const complete =
        this.settings.installTargets.length > 0 &&
        this.settings.installTargets.every((target) =>
          results.some((result) => targetKey(result.target) === targetKey(target) && result.success)
        );
      const error =
        this.prepared.errors.get(locator.installSource) ??
        (results.length === 0 ? 'Skill was not found in source' : undefined);
      return { locator, results, complete, ...(error && { error }) };
    });
  }

  async retry(): Promise<SessionSkillResult[]> {
    if (this.closed) throw new Error('Installation session is closed.');
    await prepareSelection(this.locators, this.options, this.prepared);
    return this.install();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.prepared.sources.values()].map((source) => source.cleanup()));
  }
}

async function confirmSession(session: InstallSession, options: AddOptions): Promise<void> {
  const lines: string[] = [];
  const entries = session.entries();
  for (const entry of entries) {
    lines.push(
      `${pc.cyan(entry.locator.name)} ${pc.dim(formatSavedSource(entry.locator.source))}`,
      ...(await buildSkillSummaryLines(entry.locator.name, session.settings))
    );
    lines.push('');
  }
  for (const error of session.preparationErrors()) lines.push(pc.red(error));
  p.note(lines.join('\n'), 'Installation Summary');
  // Match upstream privacy gating: only known-public GitHub repositories reach the audit API.
  for (const source of session.prepared.sources.values()) {
    if (source.parsed.type !== 'github') continue;
    const ownerRepo = getOwnerRepo(source.parsed);
    if (!ownerRepo) continue;
    try {
      if ((await source.privacy) !== false) continue;
      const skills = entries
        .filter((entry) => source.entries.includes(entry))
        .map((entry) => ({ slug: entry.locator.name, displayName: entry.locator.name }));
      const security = buildSecurityLines(
        await fetchAuditData(
          ownerRepo,
          skills.map((skill) => skill.slug)
        ),
        skills,
        ownerRepo
      );
      if (security.length) p.note(security.join('\n'), 'Security Risk Assessments');
    } catch {
      /* Security information remains advisory. */
    }
  }
  if (!options.yes) {
    const confirmed = await p.confirm({ message: 'Proceed with installation?' });
    if (p.isCancel(confirmed) || !confirmed) throw new InstallationCancelled();
  }
}

/** Apply the existing add settings once across a selection from several sources. */
export async function startInstallSession(
  locators: SkillLocator[],
  options: AddOptions = {},
  explicitlySelectedAgents?: Set<AgentType>
): Promise<InstallSession> {
  if (locators.length === 0) throw new Error('Select at least one skill.');
  const selection = deduplicateSkills(locators);
  const prepared: PreparedSelection = { sources: new Map(), errors: new Map() };
  try {
    await prepareSelection(selection, options, prepared);
    const skills = selectedEntries(selection, prepared).map((entry) =>
      entry.kind === 'disk'
        ? entry.skill
        : { name: entry.skill.installName, description: entry.skill.description, path: '' }
    );
    const settings = await selectInstallSettings(skills, options, explicitlySelectedAgents);
    const session = new InstallSession(selection, settings, options, prepared);
    await confirmSession(session, options);
    return session;
  } catch (error) {
    await Promise.all([...prepared.sources.values()].map((source) => source.cleanup()));
    throw error;
  }
}

export async function runSavedAdd(options: AddOptions): Promise<void> {
  try {
    const explicitlySelectedAgents = new Set(
      options.agent?.filter((name): name is AgentType => name in agents)
    );
    if (options.all) {
      options = { ...options, skill: ['*'], agent: ['*'], yes: true };
    }
    if (options.list) {
      await runSavedList(options);
      return;
    }
    const agentResult = await detectAgent();
    if (agentResult.isAgent) {
      options = { ...options, yes: true };
      if (!options.agent?.length) {
        const mappedAgent = getAgentType(agentResult.agent.name);
        if (mappedAgent) options.agent = ensureUniversalAgents([mappedAgent]);
      }
    }
    const interactive = process.stdin.isTTY && process.stdout.isTTY && !agentResult.isAgent;
    if (!interactive && !options.yes) {
      throw new Error('Use -y with --skill or --liked to install saved skills without prompts.');
    }
    if (options.yes && !options.skill?.length && !options.liked) {
      throw new Error('Select saved skills with --skill or --liked when using -y.');
    }
    p.intro(pc.bgCyan(pc.black(' skills ')));
    let selected: SkillLocator[];
    if (interactive && !options.yes && !options.skill?.length) {
      const { browseSkills } = await import('./prompts/skill-browser.ts');
      const result = await browseSkills(options.liked);
      if (typeof result === 'symbol') throw new InstallationCancelled();
      selected = result;
    } else {
      const skills = await savedSkills(options);
      if (!skills.length) {
        if (options.skill?.length && !options.skill.includes('*')) {
          throw new Error(`Skills not found: ${options.skill.join(', ')}`);
        }
        p.log.info('No saved skills match. Install or like a skill to save it.');
        return;
      }
      selected = await chooseSkills(skills, options, 'Select saved skills to install');
    }
    const session = await startInstallSession(selected, options, explicitlySelectedAgents);
    try {
      let report = await session.install();
      while (true) {
        const failed = report.filter((item) => !item.complete);
        for (const item of failed) {
          const errors =
            item.error ??
            item.results
              .filter((result) => !result.success)
              .map((result) => `${result.agent}: ${result.error}`)
              .join('; ');
          p.log.error(sanitizeMetadata(`${item.locator.name}: ${errors}`));
        }
        p.log.success(`Installed ${report.length - failed.length} of ${report.length} skills.`);
        if (!failed.length || options.yes || !interactive) break;
        const retry = await p.confirm({ message: 'Retry failed installations?' });
        if (p.isCancel(retry) || !retry) break;
        report = await session.retry();
      }
      if (report.some((item) => !item.complete)) process.exitCode = 1;
      p.outro('Done! Review skills before use; they run with full agent permissions.');
    } finally {
      await session.close();
    }
  } catch (error) {
    if (error instanceof InstallationCancelled) p.cancel('Installation cancelled');
    else {
      p.log.error(sanitizeMetadata(errorMessage(error)));
      process.exitCode = 1;
    }
  }
}
