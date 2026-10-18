import * as p from '@clack/prompts';
import pc from 'picocolors';
import { basename } from 'node:path';
import { searchMultiselect } from './prompts/search-multiselect.ts';
import { listInstalledSkills, sanitizeName } from './installer.ts';
import { getAllLockedSkills } from './skill-lock.ts';
import { readLocalLock } from './local-lock.ts';
import { sanitizeMetadata } from './sanitize.ts';
import { filterSkills } from './skills.ts';
import { isRunningInAgent } from './detect-agent.ts';
import {
  canonicalSource,
  deduplicateSkills,
  personalSkills,
  readPersonalCatalog,
  updatePersonalSkill,
  type SkillLocator,
} from './personal-catalog.ts';
import {
  errorMessage,
  InstallationCancelled,
  parseAddOptions,
  shortenPath,
  type AddOptions,
} from './add.ts';
import type { PreparedSource } from './add-source.ts';

export type ScopeStatus = 'absent' | 'installed' | 'other-source' | 'unknown-source';
export interface InstallationInventory {
  local: Map<string, string | undefined>;
  global: Map<string, string | undefined>;
}

/** Read only this project's and the global inventory; never import them into history. */
export async function loadInstallationInventory(): Promise<InstallationInventory> {
  const [local, global, localLock, globalLock] = await Promise.all([
    listInstalledSkills({ global: false }),
    listInstalledSkills({ global: true }),
    readLocalLock(process.cwd()),
    getAllLockedSkills(),
  ]);
  const localSources = new Map(
    Object.entries(localLock.skills).map(([name, entry]) => [
      sanitizeName(name),
      entry.sourceUrl ?? entry.source,
    ])
  );
  const globalSources = new Map(
    Object.entries(globalLock).map(([name, entry]) => [
      sanitizeName(name),
      entry.sourceBaseUrl ?? entry.sourceUrl ?? entry.source,
    ])
  );
  return {
    local: new Map(
      local.map((skill) => {
        const name = basename(skill.path);
        const source = localSources.get(name);
        return [name, source ? canonicalSource(source) : undefined];
      })
    ),
    global: new Map(
      global.map((skill) => {
        const name = basename(skill.path);
        const source = globalSources.get(name);
        return [name, source ? canonicalSource(source) : undefined];
      })
    ),
  };
}

export function installationStatus(
  locator: SkillLocator,
  inventory: Map<string, string | undefined>
): ScopeStatus {
  const name = sanitizeName(locator.name);
  if (!inventory.has(name)) return 'absent';
  const source = inventory.get(name);
  if (!source) return 'unknown-source';
  return source === locator.source ? 'installed' : 'other-source';
}

export function formatSavedSource(source: string): string {
  return sanitizeMetadata(
    source.startsWith('file:')
      ? shortenPath(source.slice(5), process.cwd())
      : source.replace(/^git:(?:github\.com\/)?/, '')
  );
}

export function skillHint(skill: SkillLocator, inventory: InstallationInventory): string {
  return sanitizeMetadata(
    [
      formatSavedSource(skill.source),
      installationStatus(skill, inventory.local) === 'installed' ? 'local ✓' : '',
      installationStatus(skill, inventory.global) === 'installed' ? 'global ✓' : '',
    ]
      .filter(Boolean)
      .join(' · ')
  );
}

export async function savedSkills(options: Pick<AddOptions, 'liked'> = {}) {
  const catalog = await readPersonalCatalog();
  return personalSkills(catalog.skills, { liked: options.liked });
}

/** The same searchable multiselect used by add; no secondary views or actions. */
export async function chooseSkills<T extends SkillLocator & { liked?: boolean }>(
  skills: T[],
  options: Pick<AddOptions, 'skill' | 'yes'>,
  message: string
): Promise<T[]> {
  if (options.skill?.length && !options.skill.includes('*')) {
    const names = options.skill.map((name) => name.toLowerCase());
    const missing = names.filter(
      (name) => !skills.some((skill) => skill.name.toLowerCase() === name)
    );
    if (missing.length) throw new Error(`Skills not found: ${missing.join(', ')}`);
    return deduplicateSkills(skills.filter((skill) => names.includes(skill.name.toLowerCase())));
  }
  if (options.yes || options.skill?.includes('*')) return deduplicateSkills(skills);
  if (!process.stdin.isTTY || !process.stdout.isTTY || (await isRunningInAgent())) {
    throw new Error('Use an interactive terminal, or select skills with --skill and -y.');
  }
  const inventory = await loadInstallationInventory();
  const selected = await searchMultiselect({
    message,
    items: skills.map((skill) => ({
      value: skill,
      label: sanitizeMetadata(`${skill.name}${skill.liked ? ' ♥' : ''}`),
      hint: skillHint(skill, inventory),
    })),
    required: true,
    selectAll: true,
    maxVisible: 8,
    showSelectedSummary: false,
  });
  if (typeof selected === 'symbol') throw new InstallationCancelled();
  return deduplicateSkills(selected);
}

export async function runSavedList(
  options: Pick<AddOptions, 'liked' | 'json'> = {}
): Promise<void> {
  const skills = await savedSkills(options);
  if (!skills.length) {
    console.log(options.json ? '[]' : 'No saved skills match. Install or like a skill to save it.');
    return;
  }
  const inventory = await loadInstallationInventory();
  if (options.json) {
    console.log(
      JSON.stringify(
        skills.map((skill) => ({
          ...skill,
          installed: {
            project: installationStatus(skill, inventory.local),
            global: installationStatus(skill, inventory.global),
          },
        })),
        null,
        2
      )
    );
    return;
  }
  console.log(pc.bold('Saved Skills'));
  console.log();
  for (const skill of skills) {
    const metadata = `${skill.installCount} ${skill.installCount === 1 ? 'install' : 'installs'}`;
    console.log(
      `${pc.cyan(sanitizeMetadata(skill.name))}${skill.liked ? ' ♥' : ''} ${pc.dim(sanitizeMetadata(metadata))}`
    );
    console.log(`  ${pc.dim(skillHint(skill, inventory))}`);
  }
}

export async function runLike(args: string[]): Promise<void> {
  let prepared: PreparedSource | undefined;
  try {
    const remove = args.includes('--remove');
    const allowed = ['--skill', '-s', '--yes', '-y', '--full-depth', '--remove'];
    const invalid = args.filter((arg) => arg.startsWith('-') && !allowed.includes(arg));
    if (invalid.length) throw new Error(`Unknown options: ${invalid.join(', ')}`);
    const { source, options, errors } = parseAddOptions(args.filter((arg) => arg !== '--remove'));
    if (source.length > 1)
      errors.push('Specify one source. Use --skill to select skills within it.');
    if (errors.length) throw new Error(errors.join('\n'));
    // Validate existing state before fetching a source or changing metadata.
    const catalog = await readPersonalCatalog();
    let candidates: SkillLocator[] = personalSkills(catalog.skills);
    if (source[0]) {
      const { prepareSource } = await import('./add-source.ts');
      prepared = await prepareSource(source[0], options);
      candidates = prepared.entries.map((entry) => entry.locator);
      if (prepared.parsed.skillFilter) {
        options.skill = [...(options.skill ?? []), prepared.parsed.skillFilter];
      }
      if (options.skill?.length && !options.skill.includes('*')) {
        // Preserve add's provider display-name aliases and source @skill selectors.
        const entries = prepared.entries;
        options.skill = options.skill.flatMap((name) => {
          const matches = entries.filter((entry) =>
            entry.kind === 'disk'
              ? filterSkills([entry.skill], [name]).length > 0
              : [entry.skill.name, entry.skill.installName].some(
                  (alias) => alias.toLowerCase() === name.toLowerCase()
                )
          );
          if (!matches.length) throw new Error(`Skills not found: ${name}`);
          return matches.map((entry) => entry.locator.name);
        });
      }
    } else if (options.yes && !options.skill?.length) {
      throw new Error('Select saved skills with --skill when using -y without a source.');
    }
    if (!candidates.length) {
      if (options.skill?.length && !options.skill.includes('*')) {
        throw new Error(`Skills not found: ${options.skill.join(', ')}`);
      }
      p.log.info('No saved skills. Use skills like <source> to save one.');
      return;
    }
    const selected =
      source.length && candidates.length === 1 && !options.skill?.length
        ? candidates
        : await chooseSkills(candidates, options, `Select skills to ${remove ? 'unlike' : 'like'}`);
    for (const skill of selected) {
      await updatePersonalSkill(skill, { liked: !remove });
    }
    p.outro(
      `${remove ? 'Unliked' : 'Liked'} ${selected.length} ${selected.length === 1 ? 'skill' : 'skills'}.`
    );
  } catch (error) {
    if (error instanceof InstallationCancelled) p.cancel('Cancelled');
    else {
      p.log.error(sanitizeMetadata(errorMessage(error)));
      process.exitCode = 1;
    }
  } finally {
    await prepared?.cleanup();
  }
}
