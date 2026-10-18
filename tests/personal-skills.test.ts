import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHomeEnvironment, runCli } from '../src/test-utils.ts';
import { readPersonalCatalog, updatePersonalSkill, skillLocator } from '../src/personal-catalog.ts';

describe('personal skills CLI integration', () => {
  let root: string;
  let source: string;
  let project: string;
  let catalog: string;
  let env: Record<string, string>;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'personal-skills-cli-')));
    const home = join(root, 'home');
    source = join(root, 'source');
    project = join(root, 'project');
    await Promise.all([home, source, project].map((path) => mkdir(path)));
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: alpha\ndescription: Fixture\n---\nSkill content'
    );
    env = createTestHomeEnvironment(home);
    catalog = join(home, '.local', 'state', 'skills-cli', 'personal.json');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('counts one explicit installation across agents and projects, and retains metadata after removal', async () => {
    await updatePersonalSkill(skillLocator(source, 'alpha'), { liked: true }, catalog);
    const first = runCli(
      ['add', source, '-a', 'codex', 'claude-code', '-y', '--copy'],
      project,
      env
    );
    expect(first.exitCode, first.stderr).toBe(0);
    expect((await readPersonalCatalog(catalog)).skills[0]?.installCount).toBe(1);
    const secondProject = join(root, 'second-project');
    await mkdir(secondProject);
    expect(runCli(['add', source, '-a', 'codex', '-y'], secondProject, env).exitCode).toBe(0);
    expect(runCli(['add', source, '-a', 'codex', '-y', '-g'], project, env).exitCode).toBe(0);
    expect((await readPersonalCatalog(catalog)).skills[0]?.installCount).toBe(3);
    expect(runCli(['remove', 'alpha', '-y'], project, env).exitCode).toBe(0);
    expect((await readPersonalCatalog(catalog)).skills[0]).toMatchObject({
      installCount: 3,
      liked: true,
    });
  });

  it('counts direct lockfile restore but suppresses maintenance child installs', async () => {
    expect(runCli(['add', source, '-a', 'codex', '-y'], project, env).exitCode).toBe(0);
    const restore = runCli(['experimental_install'], project, env);
    expect(restore.exitCode, restore.stderr).toBe(0);
    expect((await readPersonalCatalog(catalog)).skills[0]?.installCount).toBe(2);
    const maintenance = runCli(['add', source, '-a', 'codex', '-y'], project, {
      ...env,
      SKILLS_CLI_INSTALL_REASON: 'maintenance',
    });
    expect(maintenance.exitCode, maintenance.stderr).toBe(0);
    expect((await readPersonalCatalog(catalog)).skills[0]?.installCount).toBe(2);
  });

  it('keeps JSON stdout parseable and does not count failed or protective no-op installations', async () => {
    const installed = runCli(['add', source, '-a', 'codex', '-y', '--json'], project, env);
    expect(JSON.parse(installed.stdout)).toMatchObject([{ status: 'installed', name: 'alpha' }]);
    expect((await readPersonalCatalog(catalog)).skills[0]?.installCount).toBe(1);
    const noOp = runCli(
      ['add', join(project, '.agents', 'skills', 'alpha'), '-a', 'codex', '-y', '--json'],
      project,
      env
    );
    expect(noOp.exitCode, noOp.stderr).toBe(0);
    expect((await readPersonalCatalog(catalog)).skills).toHaveLength(1);
    expect((await readPersonalCatalog(catalog)).skills[0]?.installCount).toBe(1);
    const failed = runCli(
      ['add', join(root, 'missing'), '-a', 'codex', '-y', '--json'],
      project,
      env
    );
    expect(JSON.parse(failed.stdout)).toMatchObject([{ status: 'failed' }]);
    expect((await readPersonalCatalog(catalog)).skills[0]?.installCount).toBe(1);
  });

  it('keeps the original source-add invalid-agent error without a second failure message', async () => {
    const result = runCli(['add', source, '-a', 'invalid-agent', '-y'], project, env);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.match(/Invalid agents: invalid-agent/g)).toHaveLength(1);
    expect(result.stdout).toContain('Valid agents:');
    expect(result.stdout).not.toContain('Installation failed');
    const json = runCli(['add', source, '-a', 'invalid-agent', '-y', '--json'], project, env);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual([
      { status: 'failed', error: 'Invalid agents: invalid-agent' },
    ]);
    await expect(stat(catalog)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps source-less noninteractive add deterministic and help free of state changes', async () => {
    const picker = runCli(['add'], project, env);
    expect(picker.exitCode).toBe(1);
    expect(picker.stdout).toContain('Missing required argument: source');
    for (const command of ['add', 'like']) {
      const missing = runCli([command, '--skill', 'missing', '-y'], project, env);
      expect(missing.exitCode).toBe(1);
      expect(missing.stdout + missing.stderr).toContain('Skills not found: missing');
    }
    for (const args of [
      ['list', '--saved', '--json'],
      ['add', source, '--list'],
    ]) {
      const result = runCli(args, project, env);
      expect(result.exitCode, result.stderr).toBe(0);
    }
    await expect(stat(catalog)).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(catalog, '..'), { recursive: true });
    await writeFile(catalog, '{corrupt');
    expect(runCli(['--help'], project, env).exitCode).toBe(0);
    expect(await readFile(catalog, 'utf8')).toBe('{corrupt');
  });

  it('likes and unlikes skills without installing files or changing counts', async () => {
    const result = runCli(['like', source, '--skill', 'alpha'], project, env);
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect((await readPersonalCatalog(catalog)).skills[0]).toMatchObject({
      liked: true,
      installCount: 0,
    });
    await expect(stat(join(project, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(project, 'skills-lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(runCli(['like', '--skill', 'alpha', '--remove'], project, env).exitCode).toBe(0);
    expect((await readPersonalCatalog(catalog)).skills[0]?.liked).toBe(false);
  });

  it('installs a liked selection across sources once per skill with the normal add flags', async () => {
    const second = join(root, 'second-source');
    await mkdir(second);
    await writeFile(join(second, 'SKILL.md'), '---\nname: beta\ndescription: Fixture\n---\nBeta');
    await updatePersonalSkill(skillLocator(source, 'alpha'), { liked: true }, catalog);
    await updatePersonalSkill(skillLocator(second, 'beta'), { liked: true }, catalog);
    const result = runCli(
      ['add', '--liked', '-a', 'codex', 'claude-code', '-y', '--copy'],
      project,
      env
    );
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect((await readPersonalCatalog(catalog)).skills.map((skill) => skill.installCount)).toEqual([
      1, 1,
    ]);
    expect(
      await readFile(join(project, '.agents', 'skills', 'alpha', 'SKILL.md'), 'utf8')
    ).toContain('Skill content');
    expect(
      await readFile(join(project, '.claude', 'skills', 'beta', 'SKILL.md'), 'utf8')
    ).toContain('Beta');
    const listed = runCli(['list', '--saved', '--json'], project, env);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject([
      { name: 'alpha', installCount: 1, installed: { project: 'installed', global: 'absent' } },
      { name: 'beta', installCount: 1, installed: { project: 'installed', global: 'absent' } },
    ]);
    expect(
      runCli(['add', '--skill', 'alpha', '-a', 'codex', '-y', '-g'], project, env).exitCode
    ).toBe(0);
    expect((await readPersonalCatalog(catalog)).skills.map((skill) => skill.installCount)).toEqual([
      2, 1,
    ]);
  });

  it('continues after a missing saved source and counts only completed skills', async () => {
    await updatePersonalSkill(skillLocator(source, 'alpha'), { liked: true }, catalog);
    await updatePersonalSkill(
      skillLocator(join(root, 'missing'), 'missing'),
      { liked: true },
      catalog
    );
    const result = runCli(['add', '--liked', '-a', 'codex', '-y'], project, env);
    expect(result.exitCode).toBe(1);
    expect((await readPersonalCatalog(catalog)).skills.map((skill) => skill.installCount)).toEqual([
      1, 0,
    ]);
  });
});
