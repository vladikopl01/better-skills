import { sanitizeMetadata } from './sanitize.ts';
import { skillLocator, type SkillLocator } from './personal-catalog.ts';

export const SEARCH_PAGE_SIZE = 20;

export interface DiscoverySkill extends SkillLocator {
  installs: number;
}

export interface SearchSkill {
  name: string;
  slug: string;
  source: string;
  installs: number;
}

export function formatInstalls(count: number): string {
  if (!count || count <= 0) return '';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M installs`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, '')}K installs`;
  return `${count} install${count === 1 ? '' : 's'}`;
}

/** Shared transport and response validation for find and source-less add. */
export async function fetchSkillResults(
  query: string | null,
  options: { signal?: AbortSignal; owner?: string; limit?: number } = {}
): Promise<Array<SearchSkill & { skillId: string }>> {
  const base = process.env.SKILLS_API_URL || 'https://skills.sh';
  const params = new URLSearchParams({
    q: query ?? '',
    limit: String(options.limit ?? SEARCH_PAGE_SIZE),
  });
  if (options.owner) params.set('owner', options.owner);
  const path = query === null ? '/api/skills/all-time/0' : `/api/search?${params}`;
  const timeout = AbortSignal.timeout(10000);
  const response = await fetch(`${base}${path}`, {
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`skills.sh returned HTTP ${response.status}.`);
  const data: unknown = await response.json();
  if (!data || typeof data !== 'object' || !('skills' in data) || !Array.isArray(data.skills)) {
    throw new Error('Unexpected response from skills.sh.');
  }
  return data.skills
    .map((entry: unknown) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('name' in entry) ||
        typeof entry.name !== 'string' ||
        !entry.name.trim() ||
        !('source' in entry) ||
        typeof entry.source !== 'string' ||
        !('installs' in entry) ||
        typeof entry.installs !== 'number' ||
        !Number.isSafeInteger(entry.installs) ||
        entry.installs < 0
      )
        throw new Error('Invalid skill in skills.sh response.');
      const skillId =
        'skillId' in entry && typeof entry.skillId === 'string'
          ? entry.skillId
          : 'id' in entry && typeof entry.id === 'string'
            ? entry.id.slice(entry.id.lastIndexOf('/') + 1)
            : '';
      if (!skillId.trim()) throw new Error('Missing skill ID in skills.sh response.');
      return {
        name: sanitizeMetadata(entry.name),
        slug: sanitizeMetadata(
          'id' in entry && typeof entry.id === 'string' ? entry.id : `${entry.source}/${skillId}`
        ),
        skillId: sanitizeMetadata(skillId),
        source: sanitizeMetadata(entry.source),
        installs: entry.installs,
      };
    })
    .sort((a, b) => b.installs - a.installs);
}

/** Keep installation locators separate from the API's display names and slugs. */
export async function fetchSkills(
  query: string | null,
  signal: AbortSignal,
  options: { limit?: number } = {}
): Promise<DiscoverySkill[]> {
  const skills = await fetchSkillResults(query, { ...options, signal });
  return skills.map((entry) => {
    const github = /^[\w.-]+\/[\w.-]+$/.test(entry.source);
    const site = /^(?:[\w-]+\.)+[a-z]{2,}$/i.test(entry.source);
    if (!github && !site) throw new Error('Invalid skill source in skills.sh response.');
    // skills.sh repositories are public GitHub sources, independent of GH_HOST.
    const source = github ? `https://github.com/${entry.source}.git` : `https://${entry.source}`;
    return {
      ...skillLocator(source, github ? entry.name : entry.skillId),
      installs: entry.installs,
    };
  });
}
