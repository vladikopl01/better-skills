import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { emitKeypressEvents, type Key } from 'node:readline';
import { PassThrough } from 'node:stream';
import { browseSkills } from './skill-browser.ts';
import { approxStringWidth, cancelSymbol, countVisualRowsForLines } from './search-multiselect.ts';
import {
  getPersonalCatalogPath,
  readPersonalCatalog,
  skillLocator,
  updatePersonalSkill,
} from '../personal-catalog.ts';
import { createTestHomeEnvironment } from '../test-utils.ts';
import * as addSource from '../add-source.ts';

const alpha = { source: 'owner/repo', name: 'alpha', skillId: 'alpha', installs: 9000 };
const beta = { source: 'owner/repo', name: 'beta', skillId: 'beta', installs: 2000 };
const locator = (name: string) => skillLocator('https://github.com/owner/repo.git', name);
const press = (name: string, extra: Partial<Key> = {}) =>
  process.stdin.emit('keypress', '', { name, ...extra });
const type = (text: string) => {
  for (const char of text) press(char, { sequence: char });
};

describe('skill browser', () => {
  let root: string;
  let prompt: ReturnType<typeof browseSkills> | undefined;
  const output = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  let write: ReturnType<typeof output>;
  const frame = () => stripVTControlCharacters(String(write.mock.calls.at(-1)?.[0]));
  const stdoutRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  const stdoutColumns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-browser-'));
    for (const [name, value] of Object.entries(createTestHomeEnvironment(join(root, 'home')))) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv('GH_HOST', 'github.com');
    vi.spyOn(process, 'cwd').mockReturnValue(root);
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 24 });
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 80 });
    write = output();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ skills: [beta, alpha] })));
  });

  afterEach(async () => {
    press('c', { ctrl: true });
    await prompt;
    prompt = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const [name, descriptor] of [
      ['rows', stdoutRows],
      ['columns', stdoutColumns],
    ] as const) {
      if (descriptor) Object.defineProperty(process.stdout, name, descriptor);
      else Reflect.deleteProperty(process.stdout, name);
    }
    await rm(root, { recursive: true, force: true });
  });

  async function open(liked = false) {
    prompt = browseSkills(liked);
    await vi.waitFor(() => expect(frame()).toContain('Choose skills to install'));
  }

  it('opens search with empty state, and keeps likes and personal history distinct from global rankings', async () => {
    await updatePersonalSkill(locator('alpha'), { liked: true });
    await updatePersonalSkill(locator('beta'), { increment: true });
    await open();
    expect(frame()).toContain('[Search]');
    expect(fetch).not.toHaveBeenCalled();
    press('tab');
    expect(frame()).toContain('[Liked]');
    expect(frame()).toContain('alpha owner/repo 0 installs by you ♥');
    expect(frame()).not.toContain('○ beta');
    press('tab');
    await vi.waitFor(() => expect(frame()).toContain('9K installs'));
    expect(frame()).toContain('Top skills on skills.sh (2)');
    expect(frame()).not.toContain('Filter:');
    expect(frame().indexOf('○ alpha')).toBeLessThan(frame().indexOf('○ beta'));
    press('tab');
    expect(frame()).toContain('[Your most installed]');
    expect(frame()).toContain('1 install by you');
    expect(frame()).toContain('○ beta');
    expect(frame()).not.toContain('♥');
    expect((await readPersonalCatalog()).skills.map((skill) => skill.installCount)).toEqual([0, 1]);
  });

  it('likes a search result without installing, and deduplicates selections carried across tabs', async () => {
    await open();
    type('alpha');
    await vi.waitFor(() => expect(frame()).toContain('○ alpha'));
    press('l', { ctrl: true });
    await vi.waitFor(() => expect(frame()).toContain('alpha owner/repo 9K installs ♥'));
    expect((await readPersonalCatalog()).skills).toMatchObject([
      { name: 'alpha', liked: true, installCount: 0 },
    ]);
    await expect(stat(join(root, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    const input = new PassThrough();
    emitKeypressEvents(input);
    input.on('keypress', (text, key: Key) => process.stdin.emit('keypress', text, key));
    input.end('\u0000');
    await vi.waitFor(() => expect(frame()).toContain('(1 selected)'));
    press('tab');
    expect(frame()).toContain('● alpha owner/repo 0 installs by you ♥');
    expect(frame()).toContain('(1 selected)');
    press('return');
    await expect(prompt).resolves.toMatchObject([{ ...locator('alpha'), liked: true }]);
  });

  it('keeps local likes usable when skills.sh fails and retries on revisiting a remote tab', async () => {
    await updatePersonalSkill(locator('alpha'), { liked: true });
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Offline'));
    await open();
    press('left');
    press('left');
    await vi.waitFor(() => expect(frame()).toContain('Offline'));
    press('left');
    expect(frame()).toContain('alpha owner/repo 0 installs by you ♥');
    expect(frame()).not.toContain('Offline');
    press('right');
    await vi.waitFor(() => expect(frame()).toContain('9K installs'));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('marks the same source selected after changing tabs and searching again', async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      Response.json({ skills: [beta, alpha, { ...alpha, source: 'other/repo' }] })
    );
    await open();
    type('alpha');
    await vi.waitFor(() => expect(frame()).toContain('○ alpha owner/repo'));
    press('space', { ctrl: true });
    expect(frame()).toContain('● alpha owner/repo');
    press('tab');
    press('tab', { shift: true });
    expect(frame()).toContain('Search: alpha');
    expect(frame()).toContain('● alpha owner/repo');
    for (let index = 0; index < 'alpha'.length; index++) press('backspace');
    type('alpha');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(frame()).toContain('● alpha owner/repo'));
    expect(frame()).toContain('○ alpha other/repo');
    expect(frame()).toContain('(1 selected)');
    press('return');
    await expect(prompt).resolves.toMatchObject([locator('alpha')]);
  });

  it('ignores stale search responses, aborts on cancel, and restores prompt listeners', async () => {
    let finishFirst: ((value: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        })
    );
    const listeners = process.stdin.listenerCount('keypress');
    const resizeListeners = process.stdout.listenerCount('resize');
    await open();
    type('old');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const firstSignal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
    type('new');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(frame()).toContain('alpha'));
    finishFirst?.(Response.json({ skills: [{ ...alpha, name: 'stale' }] }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(frame()).not.toContain('stale');
    press('escape');
    await expect(prompt).resolves.toBe(cancelSymbol);
    expect(process.stdin.listenerCount('keypress')).toBe(listeners);
    expect(process.stdout.listenerCount('resize')).toBe(resizeListeners);
    await expect(stat(getPersonalCatalogPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses Space to toggle Search selections without changing the query', async () => {
    await open();
    type('react');
    await vi.waitFor(() => expect(frame()).toContain('○ alpha'));
    press('space', { sequence: ' ' });
    expect(frame()).toContain('● alpha');
    expect(frame()).toContain('(1 selected)');
    expect(frame()).toContain('Search: react');
    press('space', { sequence: ' ' });
    expect(frame()).toContain('○ alpha');
    expect(frame()).not.toContain('selected)');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('paginates Search with Ctrl+P/N and keeps selections, tab position, and cached pages', async () => {
    const skills = Array.from({ length: 45 }, (_, index) => ({
      source: 'owner/repo',
      name: `skill-${String(index).padStart(2, '0')}`,
      skillId: `skill-${String(index).padStart(2, '0')}`,
      installs: 100 - index,
    }));
    vi.mocked(fetch).mockImplementation(async (url) => {
      const limit = Number(new URL(String(url)).searchParams.get('limit'));
      return Response.json({ skills: skills.slice(0, limit) });
    });
    await open();
    type('skill');
    await vi.waitFor(() => expect(frame()).toContain('○ skill-00'));
    expect(frame()).toContain('1/20 · Page 1');
    expect(frame()).toContain('Ctrl+P/N pages');
    const input = new PassThrough();
    emitKeypressEvents(input);
    input.on('keypress', (text, key: Key) => process.stdin.emit('keypress', text, key));
    input.write('\u0010'); // Ctrl+P at the first page leaves it unchanged.
    expect(frame()).toContain('1/20 · Page 1');
    expect(fetch).toHaveBeenCalledOnce();
    press('space');
    input.write('\u000e'); // Ctrl+N
    await vi.waitFor(() => expect(frame()).toContain('○ skill-20'));
    expect(frame()).toContain('1/20 · Page 2');
    press('space');
    press('down');
    press('tab');
    press('tab', { shift: true });
    expect(frame()).toContain('Search: skill');
    expect(frame()).toContain('● skill-20');
    expect(frame()).toContain('2/20 · Page 2');
    expect(fetch).toHaveBeenCalledTimes(2);
    input.write('\u000e');
    await vi.waitFor(() => expect(frame()).toContain('1/5 · Page 3'));
    input.write('\u000e');
    expect(fetch).toHaveBeenCalledTimes(3);
    input.write('\u0010');
    input.end('\u0010');
    expect(frame()).toContain('● skill-00');
    expect(frame()).toContain('(2 selected)');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).searchParams.get('limit'))
    ).toEqual(['20', '40', '60']);
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 16 });
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 40 });
    process.stdout.emit('resize');
    expect(frame()).toContain('● skill-00');
    expect(countVisualRowsForLines(frame().trimEnd().split('\n'), 40)).toBeLessThan(16);
    press('return');
    await expect(prompt).resolves.toMatchObject([locator('skill-00'), locator('skill-20')]);
  });

  it('keeps the current page and selection when fetching more fails, and retries on Ctrl+N', async () => {
    const skills = Array.from({ length: 25 }, (_, index) => ({
      ...alpha,
      name: `skill-${String(index).padStart(2, '0')}`,
      installs: 100 - index,
    }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ skills: skills.slice(0, 20) }))
      .mockRejectedValueOnce(new Error('Offline'))
      // A larger API limit can change ranking and omit previously returned skills.
      .mockResolvedValueOnce(Response.json({ skills: skills.slice(5) }));
    await open();
    type('skill');
    await vi.waitFor(() => expect(frame()).toContain('○ skill-00'));
    press('space');
    press('n', { ctrl: true });
    await vi.waitFor(() => expect(frame()).toContain('Offline'));
    expect(frame()).toContain('Press Ctrl+N to retry.');
    expect(frame()).toContain('● skill-00');
    expect(frame()).toContain('Page 1');
    press('n', { ctrl: true });
    await vi.waitFor(() => expect(frame()).toContain('1/5 · Page 2'));
    expect(frame()).not.toContain('Offline');
    press('pageup');
    expect(frame()).toContain('● skill-00');
    press('return');
    await expect(prompt).resolves.toMatchObject([locator('skill-00')]);
  });

  it('cancels unfinished pagination on tab changes or details and ignores late responses', async () => {
    const skills = Array.from({ length: 40 }, (_, index) => ({
      ...alpha,
      name: `skill-${String(index).padStart(2, '0')}`,
      installs: 100 - index,
    }));
    let complete!: (response: Response) => void;
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ skills: skills.slice(0, 20) }))
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          })
      );
    await open();
    type('skill');
    await vi.waitFor(() => expect(frame()).toContain('○ skill-00'));
    press('space');
    press('pagedown');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(fetch).mock.calls[1]?.[1]?.signal;
    press('tab');
    expect(signal?.aborted).toBe(true);
    press('tab', { shift: true });
    complete(Response.json({ skills }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(frame()).toContain('1/20 · Page 1');
    expect(frame()).toContain('● skill-00');
    expect(frame()).not.toContain('skill-20');
    vi.spyOn(addSource, 'readSkillDetails').mockResolvedValue('Full skill instructions');
    press('pagedown');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const nextSignal = vi.mocked(fetch).mock.calls[2]?.[1]?.signal;
    press('d', { ctrl: true });
    await vi.waitFor(() => expect(frame()).toContain('Full skill instructions'));
    expect(nextSignal?.aborted).toBe(true);
    complete(Response.json({ skills }));
    press('escape');
    await new Promise((resolve) => setImmediate(resolve));
    expect(frame()).toContain('1/20 · Page 1');
    expect(frame()).toContain('● skill-00');
    press('return');
    await expect(prompt).resolves.toMatchObject([locator('skill-00')]);
  });

  it('distinguishes duplicate names inline and opens details without losing selection or query', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        skills: [
          { ...alpha, name: 'better-ui', source: 'owner/one' },
          { ...beta, name: 'better-ui', source: 'owner/two' },
        ],
      })
    );
    const preview = vi
      .spyOn(addSource, 'readSkillDetails')
      .mockResolvedValue(
        '---\nname: better-ui\ndescription: Review interface layout\n---\n\u001b[2JDetailed instructions'
      );
    await open();
    type('better-ui');
    await vi.waitFor(() => expect(frame()).toContain('owner/one'));
    const rows = frame()
      .split('\n')
      .filter((line) => line.includes('○ better-ui'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('owner/one 9K installs');
    expect(rows[1]).toContain('owner/two 2K installs');
    expect(preview).not.toHaveBeenCalled();
    press('space', { ctrl: true });
    press('d', { ctrl: true });
    await vi.waitFor(() => expect(frame()).toContain('Detailed instructions'));
    expect(preview).toHaveBeenCalledWith(
      expect.objectContaining(skillLocator('https://github.com/owner/one.git', 'better-ui')),
      expect.any(AbortSignal)
    );
    expect(frame()).toContain('description: Review interface layout');
    press('escape');
    expect(frame()).toContain('Search: better-ui');
    expect(frame()).toContain('(1 selected)');
    expect(frame()).toContain('● better-ui');
    expect((await readPersonalCatalog()).skills).toEqual([]);
    press('return');
    await expect(prompt).resolves.toMatchObject([
      { name: 'better-ui', source: 'git:github.com/owner/one' },
    ]);
  });

  it('keeps liked status visible beside counts when long skill rows are truncated', async () => {
    const skill = {
      ...alpha,
      name: 'thermo-nuclear-code-quality-review',
      source: 'owner/a-long-repo-name',
    };
    await updatePersonalSkill(skillLocator(`https://github.com/${skill.source}.git`, skill.name), {
      liked: true,
      increment: true,
    });
    vi.mocked(fetch).mockImplementation(async () => Response.json({ skills: [skill] }));
    await open();
    type('skill');
    for (const count of ['9K installs', '1 install by you', '9K installs', '1 install by you']) {
      await vi.waitFor(() => expect(frame()).toContain(count));
      for (const columns of [40, 80, 120]) {
        Object.defineProperty(process.stdout, 'columns', { configurable: true, value: columns });
        process.stdout.emit('resize');
        const row = frame()
          .split('\n')
          .find((line) => line.includes('○'));
        expect(row).toContain(`${count} ♥`);
        expect(approxStringWidth(row ?? '')).toBeLessThanOrEqual(columns);
      }
      press('tab');
    }
    press('l', { ctrl: true });
    await vi.waitFor(() => expect(frame()).not.toContain('♥'));
  });

  it('shows the saved revision used by a preview while retaining ecosystem counts', async () => {
    const saved = skillLocator('https://github.com/owner/repo.git#release', 'alpha');
    await updatePersonalSkill(saved, { liked: true });
    const preview = vi.spyOn(addSource, 'readSkillDetails').mockResolvedValue('Pinned content');
    await open();
    type('alpha');
    await vi.waitFor(() => expect(frame()).toContain('9K installs'));
    press('d', { ctrl: true });
    await vi.waitFor(() => expect(frame()).toContain('Pinned content'));
    expect(frame()).toContain(`Source: ${saved.installSource}`);
    expect(frame()).toContain('9K installs on skills.sh');
    expect(preview).toHaveBeenCalledWith(expect.objectContaining(saved), expect.any(AbortSignal));
  });

  it('cancels an in-flight preview when leaving details and when cancelling the picker', async () => {
    vi.spyOn(addSource, 'readSkillDetails').mockImplementation(
      (_skill, signal) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        )
    );
    await open();
    type('alpha');
    await vi.waitFor(() => expect(frame()).toContain('○ alpha'));
    press('d', { ctrl: true });
    const first = vi.mocked(addSource.readSkillDetails).mock.calls[0]?.[1];
    expect(first?.aborted).toBe(false);
    press('escape');
    expect(first?.aborted).toBe(true);
    expect(frame()).toContain('Search: alpha');
    press('d', { ctrl: true });
    const second = vi.mocked(addSource.readSkillDetails).mock.calls[1]?.[1];
    press('c', { ctrl: true });
    await expect(prompt).resolves.toBe(cancelSymbol);
    expect(second?.aborted).toBe(true);
  });

  it('scrolls the whole list while keeping a compact frame within the terminal', async () => {
    for (let index = 0; index < 12; index++) {
      await updatePersonalSkill(locator(`skill-${String(index).padStart(2, '0')}`), {
        liked: true,
      });
    }
    await open(true);
    for (let index = 0; index < 11; index++) press('down');
    expect(frame()).toContain('skill-11');
    expect(frame()).toContain('12/12');
    expect(countVisualRowsForLines(frame().trimEnd().split('\n'), 80)).toBeLessThan(24);
    Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 16 });
    Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 40 });
    process.stdout.emit('resize');
    expect(frame()).toContain('skill-11');
    expect(countVisualRowsForLines(frame().trimEnd().split('\n'), 40)).toBeLessThan(16);
    press('return');
    await expect(prompt).resolves.toMatchObject([{ name: 'skill-11' }]);
  });
});
