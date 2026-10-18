import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseSkills,
  installationStatus,
  loadInstallationInventory,
  savedSkills,
  runLike,
} from './saved-skills.ts';
import { InstallationCancelled } from './add.ts';
import { readPersonalCatalog, skillLocator, updatePersonalSkill } from './personal-catalog.ts';
import * as multiselect from './prompts/search-multiselect.ts';
import * as installer from './installer.ts';
import * as lock from './skill-lock.ts';
import * as localLock from './local-lock.ts';
import { createTestHomeEnvironment } from './test-utils.ts';
import { wellKnownProvider } from './providers/index.ts';

vi.mock('./detect-agent.ts', async (original) => ({
  ...(await original<typeof import('./detect-agent.ts')>()),
  isRunningInAgent: vi.fn().mockResolvedValue(false),
}));

describe('saved skill selection', () => {
  let root: string;
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'saved-skills-'));
    for (const [name, value] of Object.entries(createTestHomeEnvironment(join(root, 'home')))) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv('GH_HOST', 'github.com');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.spyOn(installer, 'listInstalledSkills').mockResolvedValue([]);
    vi.spyOn(lock, 'getAllLockedSkills').mockResolvedValue({});
    vi.spyOn(localLock, 'readLocalLock').mockResolvedValue({ version: 1, skills: {} });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    await rm(root, { recursive: true, force: true });
  });

  it('chooses filtered skills once in count order, with a compact source and installed hint', async () => {
    const alpha = skillLocator('owner/repo', 'alpha');
    const beta = skillLocator('owner/repo', 'beta');
    await updatePersonalSkill(alpha, { liked: true });
    await updatePersonalSkill(beta, { increment: true });
    const skills = await savedSkills();
    const picker = vi.spyOn(multiselect, 'searchMultiselect').mockResolvedValue([skills[1]!]);
    const selected = await chooseSkills(skills, {}, 'Select saved skills to install');
    expect(selected.map((skill) => skill.name)).toEqual(['alpha']);
    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0]?.[0]).toMatchObject({
      message: 'Select saved skills to install',
      items: [
        { label: 'beta', hint: 'owner/repo' },
        { label: 'alpha ♥', hint: 'owner/repo' },
      ],
      selectAll: true,
      showSelectedSummary: false,
    });
    expect(await savedSkills({ liked: true })).toEqual([skills[1]]);
  });

  it('cancels before writing or installing anything', async () => {
    vi.spyOn(multiselect, 'searchMultiselect').mockResolvedValue(multiselect.cancelSymbol);
    await expect(
      chooseSkills([skillLocator('owner/repo', 'alpha')], {}, 'Select skills')
    ).rejects.toBeInstanceOf(InstallationCancelled);
    expect((await readPersonalCatalog()).skills).toEqual([]);
  });

  it('matches explicit skill names without a prompt and rejects a missing name', async () => {
    const alpha = skillLocator('owner/repo', 'alpha');
    const beta = skillLocator('other/repo', 'beta');
    const picker = vi.spyOn(multiselect, 'searchMultiselect');
    await expect(
      chooseSkills([alpha, beta, alpha], { skill: ['ALPHA'] }, 'Select skills')
    ).resolves.toEqual([alpha]);
    await expect(
      chooseSkills([alpha, beta], { skill: ['missing'] }, 'Select skills')
    ).rejects.toThrow('Skills not found: missing');
    expect(picker).not.toHaveBeenCalled();
  });

  it('accepts provider display names when saving skills and retains their install identity', async () => {
    vi.spyOn(wellKnownProvider, 'fetchAllSkills').mockResolvedValue([
      {
        name: 'Friendly title',
        installName: 'provider-slug',
        description: 'Fixture',
        sourceUrl: 'https://example.test',
        content: '---\nname: Friendly title\ndescription: Fixture\n---\nContent',
        indexEntry: { name: 'provider-slug', description: 'Fixture', files: ['SKILL.md'] },
        files: new Map([
          ['SKILL.md', '---\nname: Friendly title\ndescription: Fixture\n---\nContent'],
        ]),
      },
    ]);
    await runLike(['https://example.test', '--skill', 'Friendly title']);
    expect((await readPersonalCatalog()).skills).toMatchObject([
      {
        name: 'provider-slug',
        liked: true,
        installCount: 0,
      },
    ]);
  });

  it('distinguishes local and global installations from different or unknown sources', () => {
    const locator = skillLocator('owner/repo', 'alpha');
    expect(installationStatus(locator, new Map())).toBe('absent');
    expect(installationStatus(locator, new Map([['alpha', undefined]]))).toBe('unknown-source');
    expect(
      installationStatus(locator, new Map([['alpha', skillLocator('other/repo', 'alpha').source]]))
    ).toBe('other-source');
    expect(installationStatus(locator, new Map([['alpha', locator.source]]))).toBe('installed');
  });

  it('joins inventory by installation folder, without importing it into the saved catalog', async () => {
    const path = join(root, '.agents', 'skills', 'provider-slug');
    vi.mocked(installer.listInstalledSkills).mockImplementation(async (options) =>
      options?.global
        ? []
        : [
            {
              name: 'Friendly provider title',
              description: 'Fixture',
              path,
              canonicalPath: path,
              scope: 'project',
              agents: ['codex'],
            },
          ]
    );
    vi.mocked(localLock.readLocalLock).mockResolvedValue({
      version: 1,
      skills: {
        'provider-slug': {
          source: 'https://example.test',
          sourceType: 'well-known',
          computedHash: 'fixture',
        },
      },
    });
    const inventory = await loadInstallationInventory();
    const locator = skillLocator('https://example.test', 'provider-slug');
    expect(installationStatus(locator, inventory.local)).toBe('installed');
    expect(installationStatus(locator, inventory.global)).toBe('absent');
    expect((await readPersonalCatalog()).skills).toEqual([]);
  });
});
