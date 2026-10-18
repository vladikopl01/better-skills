import { mkdir, open, readFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSource, sanitizeSubpath } from './source-parser.ts';
import type { ParsedSource } from './types.ts';

export interface SkillLocator {
  source: string;
  installSource: string;
  name: string;
}

export interface PersonalSkill extends SkillLocator {
  liked: boolean;
  installCount: number;
}

export interface PersonalCatalog {
  version: 1;
  skills: PersonalSkill[];
}

export function getPersonalCatalogPath(): string {
  return process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, 'skills-cli', 'personal.json')
    : join(homedir(), '.agents', 'skills-cli', 'personal.json');
}

/** Decode saved subtrees without depending on GH_HOST to recognize an Enterprise tree URL. */
export function parsePersonalSource(input: string): ParsedSource {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return parseSource(input);
  }
  const subpath = url.searchParams.get('skills-cli-subpath');
  if (!/^https?:$/.test(url.protocol) || !url.pathname.endsWith('.git') || subpath === null) {
    return parseSource(input);
  }
  url.searchParams.delete('skills-cli-subpath');
  return { ...parseSource(url.toString()), subpath: sanitizeSubpath(subpath) };
}

/** Git transport, revision and subtree are replay details, not distinct histories. */
export function canonicalSource(input: string): string {
  if (input.startsWith('notion:')) return input;
  const originalSource = parsePersonalSource(input);
  if (originalSource.type === 'local') {
    return `file:${resolve(originalSource.localPath ?? originalSource.url)}`;
  }
  // Normalize SCP-style SSH before the upstream parser (which expects a Git URL).
  const ssh = input.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/);
  const parsed =
    ssh && !input.includes('://') && !input.startsWith('github:') && !input.startsWith('gitlab:')
      ? parseSource(`ssh://${ssh[1]}/${ssh[2]}`)
      : originalSource;
  try {
    const url = new URL(parsed.url);
    // The upstream parser recognizes some GitHub forms with permissive patterns.
    // Never let that discard an explicitly supplied, different host in personal identity.
    try {
      const original = new URL(input);
      if (original.host && original.host.toLowerCase() !== url.host.toLowerCase()) {
        return `git:${original.host.toLowerCase()}${original.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`;
      }
    } catch {
      /* Shorthand and SCP-style SSH do not have a URL host. */
    }
    const host = url.host.toLowerCase();
    let path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    if (host === 'github.com') path = path.toLowerCase();
    if (['github', 'gitlab', 'git'].includes(parsed.type) || url.protocol === 'ssh:') {
      return `git:${host}${path}`;
    }
    url.hash = '';
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return parsed.url;
  }
}

export function skillLocator(installSource: string, name: string): SkillLocator {
  const parsed = parsePersonalSource(installSource);
  let replay = parsed.type === 'local' ? (parsed.localPath ?? parsed.url) : installSource;
  if (
    (parsed.type === 'github' || parsed.type === 'git') &&
    /^https?:\/\//.test(parsed.url) &&
    new URL(parsed.url).pathname.endsWith('.git')
  ) {
    const url = new URL(parsed.url);
    // Retain explicit hosts even if an upstream permissive URL pattern matched another host.
    if (!/^https?:\/\//.test(installSource) || new URL(installSource).host === url.host) {
      // The personal-only query retains a default-branch subtree without inventing a ref.
      // Store refs separately so slash-containing branch names remain unambiguous.
      if (parsed.subpath) url.searchParams.set('skills-cli-subpath', parsed.subpath);
      url.hash =
        (parsed.ref ? encodeURIComponent(parsed.ref) : '') +
        (parsed.skillFilter ? `@${encodeURIComponent(parsed.skillFilter)}` : '');
      replay = url.toString();
    }
  }
  return {
    source: canonicalSource(installSource),
    installSource: replay,
    name,
  };
}

export function personalSkillKey(skill: Pick<SkillLocator, 'source' | 'name'>): string {
  return JSON.stringify([skill.source, skill.name]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCatalog(value: unknown): PersonalCatalog {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.skills)) {
    throw new Error('Unsupported or invalid personal catalog.');
  }
  const skills: PersonalSkill[] = [];
  const keys = new Set<string>();
  for (const entry of value.skills) {
    if (
      !isRecord(entry) ||
      typeof entry.source !== 'string' ||
      !entry.source ||
      typeof entry.installSource !== 'string' ||
      !entry.installSource ||
      typeof entry.name !== 'string' ||
      !entry.name ||
      typeof entry.liked !== 'boolean' ||
      typeof entry.installCount !== 'number' ||
      !Number.isSafeInteger(entry.installCount) ||
      entry.installCount < 0
    )
      throw new Error('Invalid personal skill record.');
    const skill: PersonalSkill = {
      source: entry.source,
      installSource: entry.installSource,
      name: entry.name,
      liked: entry.liked,
      installCount: entry.installCount,
    };
    const key = personalSkillKey(skill);
    if (keys.has(key)) throw new Error('Duplicate personal skill record.');
    keys.add(key);
    skills.push(skill);
  }
  return { version: 1, skills };
}

export async function readPersonalCatalog(
  path = getPersonalCatalogPath()
): Promise<PersonalCatalog> {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { version: 1, skills: [] };
    throw error;
  }
  try {
    return parseCatalog(JSON.parse(content));
  } catch (error) {
    throw new Error(
      `Cannot read personal catalog ${path}; the file was preserved. ${error instanceof Error ? error.message : ''}`
    );
  }
}

async function ownerIsGone(path: string): Promise<boolean> {
  try {
    const owner: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      !isRecord(owner) ||
      typeof owner.pid !== 'number' ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0
    )
      return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return isRecord(error) && error.code === 'ESRCH';
    }
  } catch {
    // Missing or invalid ownership cannot prove that the process is gone.
    return false;
  }
}

async function removeCatalogLock(lock: string, owner?: string): Promise<void> {
  if (owner) await rm(join(lock, owner), { force: true });
  try {
    // A delayed cleanup must never remove a new owner's populated directory.
    await rmdir(lock);
  } catch (error) {
    if (!isRecord(error) || !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(error.code)))
      throw error;
  }
}

async function acquireCatalogLock(path: string): Promise<() => Promise<void>> {
  const lock = `${path}.lock`;
  const token = randomUUID();
  const owner = `owner.${token}.json`;
  const candidate = `${lock}.${token}`;
  const deadline = Date.now() + 5000;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(candidate, { mode: 0o700 });
  try {
    const file = await open(join(candidate, owner), 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ pid: process.pid }));
    } finally {
      await file.close();
    }
    while (true) {
      try {
        // Publish ownership atomically; rename cannot replace a populated live lock.
        await rename(candidate, lock);
        return () => removeCatalogLock(lock, owner);
      } catch (error) {
        if (!isRecord(error) || !['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(String(error.code)))
          throw error;
        let entries: string[];
        try {
          entries = await readdir(lock);
        } catch (readError) {
          if (!isRecord(readError) || readError.code !== 'ENOENT') throw readError;
          // On Windows, EPERM can also mean the rename itself is forbidden.
          if (error.code === 'EPERM') throw error;
          continue;
        }
        const previous = entries[0];
        if (!entries.length) await removeCatalogLock(lock);
        else if (
          entries.length === 1 &&
          previous &&
          /^owner(?:\.[\w-]+)?\.json$/.test(previous) &&
          (await ownerIsGone(join(lock, previous)))
        ) {
          // UUID filenames keep competing stale-owner cleanups away from a new owner.
          await removeCatalogLock(lock, previous);
        }
      }
      if (Date.now() >= deadline) throw new Error(`Personal catalog is busy: ${lock}`);
      await delay(25);
    }
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}

export async function mutatePersonalCatalog(
  mutate: (catalog: PersonalCatalog) => void,
  path = getPersonalCatalogPath()
): Promise<PersonalCatalog> {
  const release = await acquireCatalogLock(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const catalog = await readPersonalCatalog(path);
    mutate(catalog);
    const validated = parseCatalog(catalog);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    return validated;
  } finally {
    await rm(temporary, { force: true });
    await release();
  }
}

export async function updatePersonalSkill(
  locator: SkillLocator,
  change: {
    liked?: boolean;
    increment?: boolean;
  },
  path = getPersonalCatalogPath()
): Promise<PersonalCatalog> {
  return mutatePersonalCatalog((catalog) => {
    const key = personalSkillKey(locator);
    let skill = catalog.skills.find((item) => personalSkillKey(item) === key);
    if (!skill) {
      skill = { ...locator, liked: false, installCount: 0 };
      catalog.skills.push(skill);
    }
    skill.installSource = locator.installSource;
    if (change.liked !== undefined) skill.liked = change.liked;
    if (change.increment) {
      if (!Number.isSafeInteger(skill.installCount + 1))
        throw new Error('Installation count limit reached.');
      skill.installCount++;
    }
  }, path);
}

export function personalSkills(
  skills: PersonalSkill[],
  filter: { liked?: boolean; query?: string } = {}
): PersonalSkill[] {
  const query = filter.query?.trim().toLowerCase();
  return skills
    .filter(
      (skill) =>
        (skill.installCount > 0 || skill.liked) &&
        (!filter.liked || skill.liked) &&
        (!query || `${skill.name} ${skill.source}`.toLowerCase().includes(query))
    )
    .sort(
      (a, b) =>
        b.installCount - a.installCount ||
        a.name.localeCompare(b.name) ||
        a.source.localeCompare(b.source)
    );
}

export function deduplicateSkills<T extends SkillLocator>(skills: T[]): T[] {
  return [...new Map(skills.map((skill) => [personalSkillKey(skill), skill])).values()];
}
