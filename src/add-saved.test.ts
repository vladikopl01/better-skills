import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as prompts from '@clack/prompts';
import { startInstallSession } from './add-saved.ts';
import { prepareSource, readSkillDetails } from './add-source.ts';
import { InstallCompletion } from './personal-history.ts';
import { installToTargets, type TargetInstallResult } from './add.ts';
import {
  getPersonalCatalogPath,
  personalSkillKey,
  readPersonalCatalog,
  skillLocator,
  updatePersonalSkill,
} from './personal-catalog.ts';
import * as agentModule from './agents.ts';
import * as installer from './installer.ts';
import * as promptModule from './prompts/search-multiselect.ts';
import { wellKnownProvider, type WellKnownSkill } from './providers/index.ts';
import * as notion from './notion-test.ts';
import * as git from './git.ts';
import * as sourceParser from './source-parser.ts';
import { createTestHomeEnvironment } from './test-utils.ts';

vi.mock('@clack/prompts', async (original) => ({
  ...(await original<typeof import('@clack/prompts')>()),
  select: vi.fn(),
  confirm: vi.fn(),
  multiselect: vi.fn(),
}));

describe('installation sessions', () => {
  let root: string;
  let project: string;
  async function fixture(directory: string, name: string): Promise<string> {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: A test skill\n---\nReal content\n`
    );
    return directory;
  }
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'personal-session-'));
    project = join(root, 'project');
    await mkdir(project);
    for (const [name, value] of Object.entries(createTestHomeEnvironment(join(root, 'home')))) {
      vi.stubEnv(name, value);
    }
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    vi.stubEnv('XDG_STATE_HOME', join(root, 'state'));
    vi.stubEnv('DISABLE_TELEMETRY', '1');
    vi.mocked(prompts.confirm).mockResolvedValue(true);
    vi.mocked(prompts.select).mockImplementation(async (options) =>
      options.message === 'Installation scope' ? false : 'copy'
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('reads skill instructions without installing files or creating personal state', async () => {
    const directory = await fixture(join(root, 'preview'), 'alpha');
    expect(await readSkillDetails(skillLocator(directory, 'alpha'))).toContain('Real content');
    expect((await readPersonalCatalog()).skills).toEqual([]);
    await expect(readFile(getPersonalCatalogPath(), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(join(project, '.agents', 'skills', 'alpha', 'SKILL.md'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('asks settings and confirmation once for multiple repositories and continues after source failures', async () => {
    const a = await fixture(join(root, 'a'), 'alpha');
    const b = await fixture(join(root, 'b'), 'beta');
    vi.spyOn(agentModule, 'detectInstalledAgents').mockResolvedValue([]);
    const agents = vi
      .spyOn(promptModule, 'searchMultiselect')
      .mockResolvedValue(['codex', 'claude-code']);
    const locators = [
      skillLocator(a, 'alpha'),
      skillLocator(b, 'beta'),
      skillLocator(join(root, 'missing'), 'missing'),
    ];
    const session = await startInstallSession([...locators, locators[0]!]);
    try {
      const report = await session.install();
      expect(report.map((skill) => skill.complete)).toEqual([true, true, false]);
      expect(agents).toHaveBeenCalledTimes(1);
      expect(prompts.select).toHaveBeenCalledTimes(2);
      expect(prompts.confirm).toHaveBeenCalledTimes(1);
      expect(
        await readFile(join(project, '.agents', 'skills', 'alpha', 'SKILL.md'), 'utf8')
      ).toContain('Real content');
      expect(
        await readFile(join(project, '.claude', 'skills', 'beta', 'SKILL.md'), 'utf8')
      ).toContain('Real content');
      expect((await readPersonalCatalog()).skills.map((skill) => skill.installCount)).toEqual([
        1, 1,
      ]);
    } finally {
      await session.close();
    }
  });

  it('retries only incomplete target work, counts partial completion once, and preserves earlier successful skills', async () => {
    const source = await fixture(join(root, 'a'), 'alpha');
    await writeFile(join(project, '.claude'), 'blocks the agent directory');
    const missing = join(root, 'later');
    const session = await startInstallSession(
      [skillLocator(source, 'alpha'), skillLocator(missing, 'later')],
      { agent: ['codex', 'claude-code'], global: false, copy: true, yes: true }
    );
    try {
      const first = await session.install();
      expect(first[0]?.results.map((result) => [result.target.agent, result.outcome])).toEqual([
        ['codex', 'installed'],
        ['claude-code', 'failed'],
      ]);
      expect((await readPersonalCatalog()).skills).toHaveLength(0);
      await rm(join(project, '.claude'));
      await fixture(missing, 'later');
      const second = await session.retry();
      expect(second.every((skill) => skill.complete)).toBe(true);
      expect(second[0]?.results.find((result) => result.target.agent === 'codex')).toEqual(
        first[0]?.results[0]
      );
      expect((await readPersonalCatalog()).skills.map((skill) => skill.installCount)).toEqual([
        1, 1,
      ]);
      await session.retry();
      expect((await readPersonalCatalog()).skills.map((skill) => skill.installCount)).toEqual([
        1, 1,
      ]);
    } finally {
      await session.close();
    }
    const reinstall = await startInstallSession([skillLocator(source, 'alpha')], {
      agent: ['codex'],
      global: false,
      copy: true,
      yes: true,
    });
    try {
      await reinstall.install();
    } finally {
      await reinstall.close();
    }
    expect(
      (await readPersonalCatalog()).skills.find((skill) => skill.name === 'alpha')?.installCount
    ).toBe(2);
  });

  it('propagates unexpected source-install exceptions but retains saved-selection successes for retry', async () => {
    const source = await fixture(join(root, 'a'), 'alpha');
    const unexpected = new Error('Unexpected installer exception');
    const install = vi.spyOn(installer, 'installSkillForAgent').mockRejectedValueOnce(unexpected);
    const prepared = await prepareSource(source);
    try {
      if (prepared.kind !== 'disk') throw new Error('Expected disk fixture');
      await expect(
        installToTargets(prepared.resolved, [prepared.resolved.skills[0]!], [{ agent: 'codex' }], {
          global: false,
          mode: 'copy',
          createMissingAgentRoot: () => true,
        })
      ).rejects.toBe(unexpected);
    } finally {
      await prepared.cleanup();
    }
    install.mockRejectedValueOnce(unexpected);
    const session = await startInstallSession([skillLocator(source, 'alpha')], {
      agent: ['codex', 'claude-code'],
      global: false,
      copy: true,
      yes: true,
    });
    try {
      const first = await session.install();
      expect(first[0]?.results.map((result) => result.success)).toEqual([false, true]);
      expect((await readPersonalCatalog()).skills).toEqual([]);
      const retried = await session.retry();
      expect(retried[0]?.complete).toBe(true);
      expect(retried[0]?.results[1]).toEqual(first[0]?.results[1]);
      expect((await readPersonalCatalog()).skills[0]?.installCount).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('does not count maintenance, empty or missing results, or protective source/destination no-ops', async () => {
    const source = await fixture(join(project, '.agents', 'skills', 'same'), 'same');
    const prepared = await prepareSource(source);
    try {
      expect(prepared.kind).toBe('disk');
      if (prepared.kind !== 'disk') throw new Error('Expected disk fixture');
      const results = await installToTargets(
        prepared.resolved,
        prepared.resolved.skills,
        [{ agent: 'codex' }],
        { global: false, mode: 'copy', createMissingAgentRoot: () => true }
      );
      const ledger = new InstallCompletion();
      const locator = skillLocator(source, 'same');
      await ledger.record(locator, [{ agent: 'codex' }], []);
      await ledger.record(locator, [], results);
      await ledger.record(locator, [{ agent: 'codex' }], results);
      const installed: TargetInstallResult = {
        ...results[0]!,
        skipped: false,
        outcome: 'installed',
      };
      await new InstallCompletion().record(
        locator,
        [{ agent: 'codex' }],
        [installed],
        'maintenance'
      );
      expect((await readPersonalCatalog()).skills).toEqual([]);
    } finally {
      await prepared.cleanup();
    }
  });

  it('rediscovers a missing skill on retry without reinstalling successful siblings', async () => {
    const source = join(root, 'repo');
    await fixture(join(source, 'skills', 'alpha'), 'alpha');
    const session = await startInstallSession(
      [skillLocator(source, 'alpha'), skillLocator(source, 'beta')],
      { agent: ['codex'], global: false, copy: true, yes: true }
    );
    try {
      const first = await session.install();
      expect(first.map((skill) => skill.complete)).toEqual([true, false]);
      await fixture(join(source, 'skills', 'beta'), 'beta');
      const retried = await session.retry();
      expect(retried.every((skill) => skill.complete)).toBe(true);
      expect(retried[0]?.results).toEqual(first[0]?.results);
      expect((await readPersonalCatalog()).skills.map((skill) => skill.installCount)).toEqual([
        1, 1,
      ]);
    } finally {
      await session.close();
    }
  });

  it('preserves corrupt metadata and reports its error separately from successful files', async () => {
    const source = await fixture(join(root, 'a'), 'alpha');
    await mkdir(join(root, 'state', 'skills-cli'), { recursive: true });
    await writeFile(getPersonalCatalogPath(), '{corrupt');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const session = await startInstallSession([skillLocator(source, 'alpha')], {
      agent: ['codex'],
      yes: true,
      global: false,
    });
    try {
      expect((await session.install())[0]?.complete).toBe(true);
      expect(await readFile(getPersonalCatalogPath(), 'utf8')).toBe('{corrupt');
      expect(diagnostic).toHaveBeenCalledWith(
        expect.stringContaining('could not save personal history')
      );
    } finally {
      await session.close();
    }
  });

  it('browses and installs well-known skills with the same target accounting', async () => {
    const skill: WellKnownSkill = {
      name: 'Provider skill',
      installName: 'provider-skill',
      description: 'Test provider',
      content: '---\nname: provider-skill\ndescription: Test provider\n---\nContent',
      sourceUrl: 'https://example.test/skills/provider-skill/SKILL.md',
      indexEntry: { name: 'provider-skill', description: 'Test provider', files: ['SKILL.md'] },
      files: new Map([
        ['SKILL.md', '---\nname: provider-skill\ndescription: Test provider\n---\nContent'],
      ]),
    };
    vi.spyOn(wellKnownProvider, 'fetchAllSkills').mockResolvedValue([skill]);
    const prepared = await prepareSource('https://example.test');
    expect(prepared.kind).toBe('well-known');
    expect((await readPersonalCatalog()).skills).toEqual([]);
    await prepared.cleanup();
    const session = await startInstallSession(
      [skillLocator('https://example.test', 'provider-skill')],
      { agent: ['codex', 'claude-code'], global: false, copy: true, yes: true }
    );
    try {
      const report = await session.install();
      expect(report[0]?.results.map((result) => result.target.agent)).toEqual([
        'codex',
        'claude-code',
      ]);
      expect(report[0]?.complete).toBe(true);
      expect((await readPersonalCatalog()).skills[0]?.installCount).toBe(1);
    } finally {
      await session.close();
    }
  });

  it('retains durable Notion pack identity after cleaning temporary source files', async () => {
    const staging = join(root, 'notion-staging');
    const pack = await fixture(join(staging, 'packs', 'pack-1'), 'design');
    vi.spyOn(notion, 'prepareNotionPackSource').mockResolvedValue({
      rootDir: staging,
      tempDir: staging,
      packCount: 1,
      skillCount: 1,
      replaySources: [{ path: pack, source: 'notion:pack:stable-pack-id' }],
    });
    const prepared = await prepareSource('notion');
    expect(prepared.entries[0]?.locator).toEqual({
      source: 'notion:pack:stable-pack-id',
      installSource: 'notion:pack:stable-pack-id',
      name: 'design',
    });
    await prepared.cleanup();
    await expect(readFile(join(pack, 'SKILL.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    {
      host: 'github.company.test',
      nextHost: 'github.com',
      input: 'owner/repo/skills/design',
      ref: undefined,
    },
    {
      host: 'github.com',
      nextHost: 'github.company.test',
      input: 'owner/repo/skills/design#release/next',
      ref: 'release/next',
    },
    {
      host: 'github.company.test',
      nextHost: 'other.company.test',
      input: 'https://github.company.test/owner/repo/tree/release/skills/design',
      ref: 'release',
    },
  ])(
    'rediscovers and selects saved $input after GH_HOST changes',
    async ({ host, nextHost, input, ref }) => {
      vi.stubEnv('GH_HOST', host);
      const saved = skillLocator(input, 'design');
      await updatePersonalSkill(saved, { liked: true });
      vi.stubEnv('GH_HOST', nextHost);
      vi.spyOn(sourceParser, 'isRepoPrivate').mockResolvedValue(true);
      let cloneCount = 0;
      const clone = vi.spyOn(git, 'cloneRepo').mockImplementation(async () => {
        const directory = join(root, `clone-${cloneCount++}`);
        await fixture(join(directory, 'skills', 'design'), 'design');
        await fixture(join(directory, 'skills', 'decoy'), 'decoy');
        return directory;
      });
      const prepared = await prepareSource(saved.installSource, { fullDepth: true });
      try {
        expect(prepared.parsed).toMatchObject({
          url: `https://${host}/owner/repo.git`,
          subpath: 'skills/design',
        });
        expect(prepared.parsed.ref).toBe(ref);
        expect(prepared.entries.map((entry) => personalSkillKey(entry.locator))).toEqual([
          personalSkillKey(saved),
        ]);
      } finally {
        await prepared.cleanup();
      }
      const session = await startInstallSession([saved], {
        agent: ['codex'],
        global: false,
        copy: true,
        yes: true,
        fullDepth: true,
      });
      try {
        expect(session.entries().map((entry) => entry.locator)).toEqual([saved]);
        expect((await session.install())[0]?.complete).toBe(true);
        expect(clone).toHaveBeenCalledTimes(2);
        expect(clone).toHaveBeenCalledWith(`https://${host}/owner/repo.git`, ref);
        expect((await readPersonalCatalog()).skills).toEqual([
          { ...saved, liked: true, installCount: 1 },
        ]);
      } finally {
        await session.close();
      }
    }
  );
});
