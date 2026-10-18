import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSkillResults, fetchSkills } from './skills-api.ts';

describe('skills.sh discovery', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses the all-time endpoint and public source identities independent of GH_HOST', async () => {
    vi.stubEnv('GH_HOST', 'github.company.test');
    vi.stubEnv('SKILLS_API_URL', 'https://skills.example');
    const fetch = vi.fn().mockImplementation(async () =>
      Response.json({
        skills: [
          { name: 'Site title', skillId: 'site-slug', source: 'example.com', installs: 3 },
          { name: 'alpha', skillId: 'alpha', source: 'owner/repo', installs: 5 },
        ],
      })
    );
    vi.stubGlobal('fetch', fetch);
    const rows = await fetchSkills(null, new AbortController().signal);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://skills.example/api/skills/all-time/0');
    expect(rows).toMatchObject([
      {
        name: 'alpha',
        source: 'git:github.com/owner/repo',
        installSource: 'https://github.com/owner/repo.git',
        installs: 5,
      },
      {
        name: 'site-slug',
        source: 'https://example.com',
        installSource: 'https://example.com',
        installs: 3,
      },
    ]);
    await fetchSkills('web design&react', new AbortController().signal);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      'https://skills.example/api/search?q=web+design%26react&limit=20'
    );
  });

  it.each([
    { skills: [{}] },
    { skills: [{ name: 'bad', skillId: 'bad', source: '/tmp/source', installs: 1 }] },
    { skills: [{ name: 'bad', skillId: 'bad', source: 'a/b', installs: -1 }] },
    { error: 'unavailable' },
  ])('rejects malformed discovery data', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    await expect(fetchSkills('test', new AbortController().signal)).rejects.toThrow();
  });

  it('accepts search IDs, sanitizes metadata, and preserves find result slugs', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        skills: [
          { id: 'owner/repo/alpha', name: 'alpha\u001b[2J', source: 'owner/repo', installs: 1 },
        ],
      })
    );
    vi.stubGlobal('fetch', fetch);
    expect(await fetchSkillResults('react native', { owner: 'owner' })).toEqual([
      {
        name: 'alpha',
        slug: 'owner/repo/alpha',
        skillId: 'alpha',
        source: 'owner/repo',
        installs: 1,
      },
    ]);
    const url = new URL(fetch.mock.calls[0]?.[0]);
    expect(url.searchParams.get('q')).toBe('react native');
    expect(url.searchParams.get('owner')).toBe('owner');
  });

  it('reports HTTP failures rather than presenting an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(fetchSkills(null, new AbortController().signal)).rejects.toThrow('HTTP 503');
  });

  it('accepts larger result batches for pagination while keeping the default limit at 20', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ skills: [] }))
    );
    const signal = new AbortController().signal;
    await fetchSkills('alpha', signal, { limit: 60 });
    await fetchSkillResults('alpha');
    expect(
      vi.mocked(fetch).mock.calls.map(([url]) => new URL(String(url)).searchParams.get('limit'))
    ).toEqual(['60', '20']);
  });
});
