import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  canonicalSource,
  deduplicateSkills,
  personalSkills,
  readPersonalCatalog,
  skillLocator,
  updatePersonalSkill,
  type PersonalSkill,
} from './personal-catalog.ts';

const execute = promisify(execFile);

describe('personal catalog', () => {
  let directory: string;
  let path: string;
  beforeEach(async () => {
    vi.stubEnv('GH_HOST', 'github.com');
    directory = await mkdtemp(join(tmpdir(), 'personal-catalog-'));
    path = join(directory, 'state', 'personal.json');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('reads an empty catalog without creating its directory', async () => {
    expect(await readPersonalCatalog(path)).toEqual({ version: 1, skills: [] });
    await expect(stat(join(directory, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('saves likes before installation and retains them when counting', async () => {
    const locator = skillLocator('owner/repo', 'design');
    await updatePersonalSkill(locator, { liked: true }, path);
    expect((await readPersonalCatalog(path)).skills).toEqual([
      { ...locator, liked: true, installCount: 0 },
    ]);
    await updatePersonalSkill(locator, { increment: true }, path);
    await updatePersonalSkill(locator, { increment: true }, path);
    expect((await readPersonalCatalog(path)).skills[0]).toMatchObject({
      liked: true,
      installCount: 2,
    });
  });

  it('preserves likes and history from older records containing tags', async () => {
    const locator = skillLocator('owner/repo', 'design');
    await mkdir(join(directory, 'state'));
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        skills: [{ ...locator, liked: true, installCount: 3, tags: ['design'] }],
      })
    );
    await updatePersonalSkill(locator, { increment: true }, path);
    expect((await readPersonalCatalog(path)).skills).toEqual([
      { ...locator, liked: true, installCount: 4 },
    ]);
  });

  it.each(['{bad json', '{"version":2,"skills":[]}', '{"version":1,"skills":[{}]}'])(
    'preserves invalid or future data: %s',
    async (content) => {
      await mkdir(join(directory, 'state'));
      await writeFile(path, content);
      await expect(
        updatePersonalSkill(skillLocator('a/b', 'test'), { liked: true }, path)
      ).rejects.toThrow('preserved');
      expect(await readFile(path, 'utf8')).toBe(content);
      await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('normalizes GitHub transports and revisions while preserving hosts and repositories', () => {
    const equivalent = [
      'Owner/Repo',
      'https://github.com/owner/repo.git',
      'git@github.com:owner/repo.git',
      'ssh://git@github.com/owner/repo.git',
      'https://github.com/owner/repo/tree/main/skills/design',
    ];
    expect(new Set(equivalent.map(canonicalSource)).size).toBe(1);
    expect(canonicalSource('https://git.company/owner/repo.git')).not.toBe(
      canonicalSource('owner/repo')
    );
    expect(canonicalSource('other/repo')).not.toBe(canonicalSource('owner/repo'));
    expect(skillLocator('./fixture', 'a').installSource).toBe(join(process.cwd(), 'fixture'));
  });

  it('keeps saved shorthand hosts and refs stable when GH_HOST changes', () => {
    vi.stubEnv('GH_HOST', 'github.company.test');
    const locator = skillLocator('owner/repo#release/next', 'design');
    expect(locator.installSource).toBe('https://github.company.test/owner/repo.git#release%2Fnext');
    vi.stubEnv('GH_HOST', 'github.com');
    expect(canonicalSource(locator.installSource)).toBe(locator.source);
    expect(canonicalSource(locator.installSource)).not.toBe(canonicalSource('owner/repo'));
  });

  it.each([
    {
      host: 'github.company.test',
      nextHost: 'github.com',
      input: 'owner/repo/skills/design',
      ref: '',
    },
    {
      host: 'github.com',
      nextHost: 'github.company.test',
      input: 'github:owner/repo/skills/design#release/next',
      ref: '#release%2Fnext',
    },
    {
      host: 'github.company.test',
      nextHost: 'other.company.test',
      input: 'https://github.company.test/owner/repo/tree/release/skills/design',
      ref: '#release',
    },
  ])('pins subtree replay for $input when GH_HOST changes', ({ host, nextHost, input, ref }) => {
    vi.stubEnv('GH_HOST', host);
    const locator = skillLocator(input, 'design');
    expect(locator.installSource).toBe(
      `https://${host}/owner/repo.git?skills-cli-subpath=skills%2Fdesign${ref}`
    );
    vi.stubEnv('GH_HOST', nextHost);
    expect(canonicalSource(locator.installSource)).toBe(locator.source);
    expect(skillLocator(locator.installSource, 'design')).toEqual(locator);
  });

  it('treats Windows drive paths as local sources rather than SSH hosts', () => {
    expect(canonicalSource('C:\\skills\\design')).toBe(
      `file:${skillLocator('C:\\skills\\design', 'design').installSource}`
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'preserves invalid install count %s',
    async (count) => {
      const skill = {
        ...skillLocator('owner/repo', 'test'),
        liked: true,
        installCount: count,
      };
      await mkdir(join(directory, 'state'));
      const content = JSON.stringify({ version: 1, skills: [skill] });
      await writeFile(path, content);
      await expect(readPersonalCatalog(path)).rejects.toThrow('preserved');
      expect(await readFile(path, 'utf8')).toBe(content);
    }
  );

  it('lists likes and history in count order with alphabetical ties, deduplicating identities', () => {
    const skill = (name: string, count: number, liked = false): PersonalSkill => ({
      ...skillLocator('owner/repo', name),
      liked,
      installCount: count,
    });
    const entries = [
      skill('z', 2, true),
      skill('a', 2),
      skill('b', 0, true),
      skill('invisible', 0),
    ];
    expect(personalSkills(entries).map((s) => s.name)).toEqual(['a', 'z', 'b']);
    const visible = personalSkills(entries, { liked: true });
    expect(visible.map((s) => s.name)).toEqual(['z', 'b']);
    expect(deduplicateSkills([...visible, ...visible])).toHaveLength(2);
  });

  it('does not lose increments from concurrent processes', async () => {
    const module = new URL('./personal-catalog.ts', import.meta.url).href;
    const code = `import { updatePersonalSkill, skillLocator } from ${JSON.stringify(module)}; for (let i=0; i<8; i++) await updatePersonalSkill(skillLocator('owner/repo','design'), {increment:true}, process.argv[1]);`;
    await Promise.all(
      [1, 2, 3].map(() => execute(process.execPath, ['--input-type=module', '-e', code, path]))
    );
    expect((await readPersonalCatalog(path)).skills[0]?.installCount).toBe(24);
  });

  it('recovers a lock only when its process is gone', async () => {
    await mkdir(`${path}.lock`, { recursive: true });
    const child = await execute(process.execPath, [
      '-e',
      'process.stdout.write(String(process.pid))',
    ]);
    await writeFile(
      join(`${path}.lock`, 'owner.json'),
      JSON.stringify({ pid: Number(child.stdout) })
    );
    // An abandoned reclaimer from the earlier implementation must not block recovery.
    await writeFile(`${path}.lock.reclaim`, '');
    await Promise.all(
      Array.from({ length: 6 }, () =>
        updatePersonalSkill(skillLocator('a/b', 'a'), { increment: true }, path)
      )
    );
    expect((await readPersonalCatalog(path)).skills).toHaveLength(1);
    expect((await readPersonalCatalog(path)).skills[0]?.installCount).toBe(6);
  });

  it('recovers an empty lock left between owner cleanup and directory removal', async () => {
    await mkdir(`${path}.lock`, { recursive: true });
    await updatePersonalSkill(skillLocator('a/b', 'a'), { liked: true }, path);
    expect((await readPersonalCatalog(path)).skills[0]?.liked).toBe(true);
    await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
