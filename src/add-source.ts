import * as p from '@clack/prompts';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { getOwnerRepo, parseOwnerRepo, isRepoPrivate } from './source-parser.ts';
import {
  wellKnownProvider,
  WellKnownScopeNotFoundError,
  type WellKnownSkill,
} from './providers/index.ts';
import type { Skill, ParsedSource } from './types.ts';
import {
  cleanup,
  InstallationCancelled,
  resolveSkills,
  type AddOptions,
  type ResolvedSkills,
} from './add.ts';
import {
  parsePersonalSource,
  personalSkillKey,
  skillLocator,
  type SkillLocator,
} from './personal-catalog.ts';
import {
  isNotionSource,
  parseNotionSkillUrl,
  prepareNotionPackSource,
  prepareNotionSkillSource,
} from './notion-test.ts';

export type PreparedSkill =
  | { kind: 'disk'; skill: Skill; locator: SkillLocator }
  | { kind: 'well-known'; skill: WellKnownSkill; locator: SkillLocator };

export type PreparedSource = {
  installSource: string;
  parsed: ParsedSource;
  entries: PreparedSkill[];
  privacy: Promise<boolean | null>;
  cleanup: () => Promise<void>;
} & ({ kind: 'disk'; resolved: ResolvedSkills; directDownload: boolean } | { kind: 'well-known' });

/** Discovery owns its temporary resources until the caller explicitly releases them. */
export async function prepareSource(
  source: string,
  options: AddOptions & { signal?: AbortSignal } = {},
  spinner: Parameters<typeof resolveSkills>[2] = p.spinner()
): Promise<PreparedSource> {
  let effectiveSource = source;
  let notionTemp: string | null = null;
  let notionReplay: Array<{ path: string; source: string }> = [];
  try {
    options.signal?.throwIfAborted();
    const pageId = parseNotionSkillUrl(source);
    const notion = isNotionSource(source) || pageId !== null;
    if (notion) {
      const prepared = pageId
        ? await prepareNotionSkillSource(pageId, { signal: options.signal, spinner })
        : await prepareNotionPackSource(
            source.startsWith('notion:pack:')
              ? { ...options, spinner, skill: [source.slice('notion:pack:'.length)], yes: true }
              : { ...options, spinner }
          );
      if (!prepared) throw new InstallationCancelled();
      effectiveSource = prepared.rootDir;
      notionTemp = prepared.tempDir;
      notionReplay = prepared.replaySources ?? [];
    }
    options.signal?.throwIfAborted();
    const parsed = parsePersonalSource(effectiveSource);
    const includeInternal =
      Boolean(options.skill?.length && !options.skill.includes('*')) || Boolean(parsed.skillFilter);
    const ownerRepo =
      parsed.type === 'github' && !options.signal
        ? parseOwnerRepo(getOwnerRepo(parsed) ?? '')
        : null;
    const privacy = ownerRepo
      ? isRepoPrivate(ownerRepo.owner, ownerRepo.repo).catch(() => null)
      : Promise.resolve(null);
    if (parsed.type === 'well-known') {
      spinner.start('Discovering skills from well-known endpoint...');
      let skills: WellKnownSkill[] = [];
      try {
        skills = await wellKnownProvider.fetchAllSkills(parsed.url, {
          includeInternal,
          signal: options.signal,
        });
      } catch (error) {
        if (error instanceof WellKnownScopeNotFoundError) throw error;
      }
      options.signal?.throwIfAborted();
      spinner.stop(`Found ${skills.length} well-known skills`);
      if (skills.length > 0) {
        return {
          kind: 'well-known',
          installSource: source,
          parsed,
          privacy,
          entries: skills.map((skill) => ({
            kind: 'well-known',
            skill,
            locator: skillLocator(source, skill.installName),
          })),
          cleanup: async () => {},
        };
      }
    }
    if (parsed.type === 'local' && !existsSync(parsed.localPath ?? parsed.url)) {
      throw new Error(`Local path does not exist: ${parsed.localPath ?? parsed.url}`);
    }
    const resolved = await resolveSkills(
      parsed,
      { includeInternal, fullDepth: options.fullDepth, signal: options.signal },
      spinner
    );
    spinner.stop(`Found ${resolved.skills.length} skills`);
    if (resolved.skills.length === 0) {
      await cleanup(resolved.tempDir);
      throw new Error(
        'No valid skills found. Skills require a SKILL.md with name and description.'
      );
    }
    return {
      kind: 'disk',
      installSource: source,
      parsed,
      privacy,
      resolved,
      directDownload: notion || parsed.type === 'download' || parsed.type === 'well-known',
      entries: resolved.skills.map((skill) => {
        const replay = notionReplay.find(
          (entry) => skill.path === entry.path || skill.path.startsWith(entry.path + sep)
        );
        return { kind: 'disk', skill, locator: skillLocator(replay?.source ?? source, skill.name) };
      }),
      cleanup: async () => {
        await cleanup(resolved.tempDir);
        await cleanup(notionTemp);
      },
    };
  } catch (error) {
    spinner.stop('Could not prepare source');
    await cleanup(notionTemp);
    throw error;
  }
}

/** Preview through the same providers as add, without installing or saving history. */
export async function readSkillDetails(
  locator: SkillLocator,
  signal?: AbortSignal
): Promise<string> {
  const timeout = AbortSignal.timeout(30000);
  const prepared = await prepareSource(
    locator.installSource,
    {
      skill: [locator.name],
      yes: true,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    },
    {
      start() {},
      stop() {},
      message() {},
    }
  );
  try {
    const entry = prepared.entries.find(
      (entry) => personalSkillKey(entry.locator) === personalSkillKey(locator)
    );
    if (!entry) throw new Error(`Skill ${locator.name} was not found in source.`);
    return entry.kind === 'well-known'
      ? entry.skill.content
      : (entry.skill.rawContent ?? (await readFile(join(entry.skill.path, 'SKILL.md'), 'utf8')));
  } finally {
    await prepared.cleanup();
  }
}
