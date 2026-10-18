import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import pc from 'picocolors';
import {
  personalSkillKey,
  personalSkills,
  readPersonalCatalog,
  updatePersonalSkill,
  type PersonalSkill,
  type SkillLocator,
} from '../personal-catalog.ts';
import {
  fetchSkills,
  formatInstalls,
  SEARCH_PAGE_SIZE,
  type DiscoverySkill,
} from '../skills-api.ts';
import { readSkillDetails } from '../add-source.ts';
import { loadInstallationInventory, skillHint } from '../saved-skills.ts';
import { sanitizeMetadata, stripTerminalEscapes } from '../sanitize.ts';
import {
  cancelSymbol,
  approxStringWidth,
  countVisualRowsForLines,
  formatDetailLines,
  wrapText,
} from './search-multiselect.ts';

const tabs = ['Search', 'Liked', 'Most installed', 'Your most installed'] as const;
type Tab = (typeof tabs)[number];
type BrowserSkill = DiscoverySkill | PersonalSkill;
const bar = pc.dim('│');

/** Discover skills, then return one selection to the existing add installer. */
export async function browseSkills(liked = false): Promise<SkillLocator[] | symbol> {
  const [catalog, inventory] = await Promise.all([
    readPersonalCatalog(),
    loadInstallationInventory(),
  ]);
  const personal = new Map(catalog.skills.map((skill) => [personalSkillKey(skill), skill]));
  const selected = new Map<string, SkillLocator>();
  let tab: Tab = liked ? 'Liked' : 'Search';
  const views = {
    Search: { query: '', cursor: 0, page: 0 },
    Liked: { query: '', cursor: 0 },
    'Most installed': { query: '', cursor: 0 },
    'Your most installed': { query: '', cursor: 0 },
  };
  let search: DiscoverySkill[] = [];
  let searchLimit = 0;
  let searchHasMore = false;
  let popular: DiscoverySkill[] | undefined;
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loading = false;
  let saving = false;
  let error = '';
  let height = 0;
  let settled = false;
  let details:
    | { skill: BrowserSkill; content: string; offset: number; controller: AbortController }
    | undefined;
  const previews = new Map<string, string>();

  function results(): BrowserSkill[] {
    if (tab === 'Search') {
      const { query, page } = views.Search;
      return query.length >= 2
        ? search.slice(page * SEARCH_PAGE_SIZE, (page + 1) * SEARCH_PAGE_SIZE)
        : [];
    }
    if (tab === 'Most installed') return popular ?? [];
    return personalSkills([...personal.values()], {
      liked: tab === 'Liked',
      query: views[tab].query,
    }).filter((skill) => tab === 'Liked' || skill.installCount > 0);
  }

  function installCount(skill: BrowserSkill): string {
    if ('installs' in skill) return formatInstalls(skill.installs) || '0 installs';
    const own = skill.installCount;
    return `${own} install${own === 1 ? '' : 's'} by you`;
  }

  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    const rl = readline.createInterface({
      input: process.stdin,
      output: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      terminal: false,
    });
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    readline.emitKeypressEvents(process.stdin, rl);
    process.stdout.write('\x1b[?25l');

    function draw(lines: string[]): void {
      const clear = height ? `\x1b[${height}A\x1b[1G\x1b[J` : '';
      process.stdout.write(clear + lines.join('\n') + '\n');
      height = countVisualRowsForLines(lines, process.stdout.columns);
    }

    function render(): void {
      if (settled) return;
      const skills = results();
      const view = views[tab];
      view.cursor = Math.max(0, Math.min(view.cursor, skills.length - 1));
      const columns = process.stdout.columns || 80;
      const clip = (text: string, width = columns - 4) =>
        width > 0 ? (formatDetailLines(text, width, 1)[0] ?? '') : '';
      if (details) {
        const header = [
          `${pc.green('◆')}  ${pc.bold(clip(sanitizeMetadata(details.skill.name), columns - 8))}${personal.get(personalSkillKey(details.skill))?.liked ? ' ♥' : ''}`,
          `${bar}  ${pc.dim(clip(sanitizeMetadata(skillHint(details.skill, inventory))))}`,
          `${bar}  ${pc.dim(installCount(details.skill))}${'installs' in details.skill ? pc.dim(' on skills.sh') : ''}`,
          `${bar}`,
        ];
        const footer = [
          ...(error ? [`${bar}  ${pc.red(clip(sanitizeMetadata(error)))}`] : []),
          `${bar}`,
          `${bar}  ${pc.dim(`↑↓ scroll · ${saving ? 'Saving like…' : 'Ctrl+L like/unlike'} · Esc back`)}`,
          pc.dim('└'),
        ];
        const body = stripTerminalEscapes(
          `Source: ${details.skill.installSource}\n\n${details.content}`
        )
          .split('\n')
          .flatMap((line) => {
            const wrapped = wrapText(line, Math.max(1, columns - 4));
            return (wrapped.length ? wrapped : ['']).map((line) => `${bar}  ${line}`);
          });
        const available = Math.max(
          1,
          (process.stdout.rows || 24) - countVisualRowsForLines([...header, ...footer], columns) - 2
        );
        details.offset = Math.max(0, Math.min(details.offset, body.length - available));
        draw([...header, ...body.slice(details.offset, details.offset + available), ...footer]);
        return;
      }
      const lines = [
        `${pc.green('◆')}  ${pc.bold('Choose skills to install')}${selected.size ? pc.dim(` (${selected.size} selected)`) : ''}`,
        `${bar}  ${tabs.map((label) => (label === tab ? pc.cyan(`[${label}]`) : pc.dim(label))).join('  ')}`,
        `${bar}`,
        tab === 'Most installed'
          ? `${bar}  ${pc.dim(`Top skills on skills.sh${popular ? ` (${popular.length})` : ''}`)}`
          : `${bar}  ${pc.dim(tab === 'Search' ? 'Search:' : 'Filter:')} ${clip(sanitizeMetadata(view.query), columns - 12)}${pc.inverse(' ')}`,
      ];
      if (!skills.length) {
        let message = 'No skills found.';
        if (tab === 'Liked') message = 'No liked skills. Find a skill in Search and press Ctrl+L.';
        if (tab === 'Your most installed') message = 'No installation history yet.';
        if (tab === 'Search' && view.query.length < 2)
          message = 'Type at least 2 characters to search skills.sh.';
        if (loading) message = 'Loading skills.sh…';
        lines.push(`${bar}  ${pc.dim(clip(message))}`);
      }
      const footer: string[] = [];
      if (loading && skills.length) footer.push(`${bar}  ${pc.dim('Loading more skills…')}`);
      if (error) footer.push(`${bar}  ${pc.red(clip(sanitizeMetadata(error)))}`);
      footer.push(`${bar}`);
      footer.push(`${bar}  ${pc.dim('Tab switch · ↑↓ move · Space select · Enter install')}`);
      footer.push(
        `${bar}  ${pc.dim(`${saving ? 'Saving like…' : 'Ctrl+L like/unlike'} · Ctrl+D details · Esc cancel`)}`
      );
      footer.push(pc.dim('└'));
      const pagination =
        tab === 'Search' && skills.length
          ? `Page ${views.Search.page + 1}${searchHasMore ? '' : `/${Math.ceil(search.length / SEARCH_PAGE_SIZE)}`} · Ctrl+P/N pages`
          : '';
      const position = `${bar}  ${pc.dim([`${view.cursor + 1}/${skills.length}`, pagination].filter(Boolean).join(' · '))}`;
      const available = Math.max(
        1,
        (process.stdout.rows || 24) -
          countVisualRowsForLines([...lines, position, ...footer], columns) -
          2
      );
      const limit = Math.min(8, skills.length, available);
      const start = Math.max(
        0,
        Math.min(view.cursor - Math.floor(limit / 2), skills.length - limit)
      );
      const rows = skills.slice(start, start + limit).map((skill, index) => {
        const key = personalSkillKey(skill);
        const liked = personal.get(key)?.liked ? ' ♥' : '';
        const count = clip(installCount(skill), columns - approxStringWidth(liked) - 12);
        const width = Math.max(1, columns - approxStringWidth(count + liked) - 8);
        const name = clip(
          sanitizeMetadata(skill.name),
          Math.min(32, width, Math.max(12, Math.ceil(width / 2)))
        );
        const hint = clip(skillHint(skill, inventory), width - approxStringWidth(name));
        const active = start + index === view.cursor;
        return `${bar} ${active ? pc.cyan('❯') : ' '} ${selected.has(key) ? pc.green('●') : pc.dim('○')} ${active ? pc.underline(name) : name} ${pc.dim(hint)} ${pc.cyan(count)}${liked}`;
      });
      if (skills.length > limit || pagination) rows.push(position);
      draw([...lines, ...rows, ...footer]);
    }

    function cancelRequest(): void {
      clearTimeout(timer);
      request?.abort();
      request = undefined;
      loading = false;
    }

    function load(page = views.Search.page): void {
      cancelRequest();
      error = '';
      const view = views[tab];
      if ((tab !== 'Search' || view.query.length < 2) && (tab !== 'Most installed' || popular))
        return;
      if (tab === 'Search' && search.length > page * SEARCH_PAGE_SIZE) {
        if (views.Search.page !== page) view.cursor = 0;
        views.Search.page = page;
        return;
      }
      const controller = new AbortController();
      request = controller;
      const searchQuery = tab === 'Search' ? view.query : null;
      const limit =
        searchQuery === null
          ? SEARCH_PAGE_SIZE
          : Math.max(searchLimit + SEARCH_PAGE_SIZE, (page + 1) * SEARCH_PAGE_SIZE);
      loading = true;
      timer = setTimeout(
        async () => {
          try {
            const skills = await fetchSkills(searchQuery, controller.signal, { limit });
            if (settled || request !== controller) return;
            if (searchQuery === null) popular = skills;
            else {
              // The API supports limit, not offset. Keep existing rows stable as limits grow.
              search = [
                ...new Map(
                  [...search, ...skills].map((skill) => [personalSkillKey(skill), skill])
                ).values(),
              ];
              searchLimit = limit;
              searchHasMore = skills.length >= limit;
              const nextPage = Math.min(
                page,
                Math.max(0, Math.ceil(search.length / SEARCH_PAGE_SIZE) - 1)
              );
              if (views.Search.page !== nextPage) views.Search.cursor = 0;
              views.Search.page = nextPage;
            }
          } catch (failure) {
            if (settled || request !== controller) return;
            const retry =
              searchQuery !== null && search.length
                ? 'Press Ctrl+N to retry.'
                : 'Switch tabs or search again to retry.';
            error = `${failure instanceof Error ? failure.message : String(failure)} ${retry}`;
          } finally {
            if (!settled && request === controller) {
              loading = false;
              render();
            }
          }
        },
        searchQuery === null ? 0 : 250
      );
    }

    function finish(value: SkillLocator[] | symbol): void {
      if (settled) return;
      settled = true;
      cancelRequest();
      details?.controller.abort();
      process.stdin.removeListener('keypress', keypress);
      process.stdout.removeListener('resize', render);
      rl.removeListener('close', cancel);
      rl.close();
      if (process.stdin.isTTY) process.stdin.setRawMode(wasRaw ?? false);
      process.stdout.write(`${height ? `\x1b[${height}A\x1b[1G\x1b[J` : ''}\x1b[?25h`);
      if (Array.isArray(value)) {
        process.stdout.write(
          `${pc.green('◇')}  Choose skills to install\n${bar}  ${pc.dim(value.map((skill) => skill.name).join(', '))}\n`
        );
      }
      resolve(value);
    }

    function cancel(): void {
      finish(cancelSymbol);
    }

    async function showDetails(skill: BrowserSkill): Promise<void> {
      cancelRequest();
      const key = personalSkillKey(skill);
      const saved = personal.get(key);
      if (saved) skill = { ...skill, installSource: saved.installSource };
      const cached = previews.get(key);
      const view = {
        skill,
        content: cached ?? 'Loading SKILL.md…',
        offset: 0,
        controller: new AbortController(),
      };
      details = view;
      render();
      if (cached !== undefined) return;
      try {
        view.content = await readSkillDetails(skill, view.controller.signal);
        if (!view.controller.signal.aborted) previews.set(key, view.content);
      } catch (failure) {
        view.content = `Could not load SKILL.md: ${failure instanceof Error ? failure.message : String(failure)}`;
      }
      if (details === view) render();
    }

    async function toggleLike(skill: SkillLocator): Promise<void> {
      if (saving) return;
      saving = true;
      error = '';
      render();
      try {
        const key = personalSkillKey(skill);
        const existing = personal.get(key);
        const updated = await updatePersonalSkill(existing ?? skill, { liked: !existing?.liked });
        for (const entry of updated.skills) personal.set(personalSkillKey(entry), entry);
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      } finally {
        saving = false;
        render();
      }
    }

    function keypress(_text: string, key: readline.Key): void {
      if (!key || settled) return;
      const view = views[tab];
      const skills = results();
      const current = details?.skill ?? skills[view.cursor];
      if (key.ctrl && key.name === 'l') {
        if (current) void toggleLike(current);
        return;
      }
      if (details && !(key.ctrl && key.name === 'c')) {
        if (key.name === 'escape' || key.name === 'return' || (key.ctrl && key.name === 'd')) {
          details.controller.abort();
          details = undefined;
        } else if (key.name === 'up') details.offset--;
        else if (key.name === 'down') details.offset++;
        else if (key.name === 'pageup') details.offset -= 8;
        else if (key.name === 'pagedown') details.offset += 8;
        render();
        return;
      }
      if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        if (!saving) cancel();
        return;
      }
      if (key.name === 'return') {
        if (saving) return;
        if (!selected.size && current) selected.set(personalSkillKey(current), current);
        if (selected.size)
          finish(
            [...selected.values()].map((skill) => personal.get(personalSkillKey(skill)) ?? skill)
          );
        return;
      }
      if (key.ctrl && key.name === 'd') {
        if (current) void showDetails(current);
        return;
      }
      const previousPage = key.name === 'pageup' || (key.ctrl && key.name === 'p');
      const nextPage = key.name === 'pagedown' || (key.ctrl && key.name === 'n');
      if (key.name === 'tab' || key.name === 'left' || key.name === 'right') {
        tab =
          tabs[
            (tabs.indexOf(tab) + (key.shift || key.name === 'left' ? tabs.length - 1 : 1)) %
              tabs.length
          ]!;
        load();
      } else if (key.name === 'up') view.cursor = Math.max(0, view.cursor - 1);
      else if (key.name === 'down') view.cursor = Math.min(skills.length - 1, view.cursor + 1);
      else if (tab === 'Search' && (previousPage || nextPage)) {
        const page = views.Search.page + (previousPage ? -1 : 1);
        if (page >= 0 && (page * SEARCH_PAGE_SIZE < search.length || searchHasMore)) load(page);
      } else if (key.name === 'space' || key.sequence === '\u0000') {
        if (current) {
          const id = personalSkillKey(current);
          if (selected.has(id)) selected.delete(id);
          else selected.set(id, current);
        }
      } else if (
        tab !== 'Most installed' &&
        (key.name === 'backspace' || (!key.ctrl && !key.meta && key.sequence?.length === 1))
      ) {
        view.query = key.name === 'backspace' ? view.query.slice(0, -1) : view.query + key.sequence;
        view.cursor = 0;
        if (tab === 'Search') {
          views.Search.page = 0;
          search = [];
          searchLimit = 0;
          searchHasMore = false;
        }
        load();
      }
      render();
    }

    process.stdin.on('keypress', keypress);
    process.stdout.on('resize', render);
    rl.on('close', cancel);
    if (process.stdin.readableEnded || process.stdin.destroyed) {
      cancel();
      return;
    }
    load();
    render();
  });
}
