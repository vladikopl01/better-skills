import { personalSkillKey, updatePersonalSkill, type SkillLocator } from './personal-catalog.ts';
import type { InstallTarget, TargetInstallResult } from './add.ts';

function targetKey(target: InstallTarget): string {
  return JSON.stringify([target.agent, target.subagent ?? null]);
}

export type InstallReason = 'explicit' | 'maintenance';
export const MAINTENANCE_ENV = 'SKILLS_CLI_INSTALL_REASON';

export function installationReason(reason?: InstallReason): InstallReason {
  return reason ?? (process.env[MAINTENANCE_ENV] === 'maintenance' ? 'maintenance' : 'explicit');
}

/** Session-only state: previous target successes survive a retry; completed skills count once. */
export class InstallCompletion {
  private outcomes = new Map<string, Map<string, TargetInstallResult>>();
  private counted = new Set<string>();

  results(locator: SkillLocator): TargetInstallResult[] {
    return [...(this.outcomes.get(personalSkillKey(locator))?.values() ?? [])];
  }

  async record(
    locator: SkillLocator,
    targets: InstallTarget[],
    results: TargetInstallResult[],
    reason: InstallReason = installationReason()
  ): Promise<void> {
    const key = personalSkillKey(locator);
    const previous = this.outcomes.get(key) ?? new Map<string, TargetInstallResult>();
    for (const result of results) previous.set(targetKey(result.target), result);
    this.outcomes.set(key, previous);
    if (reason === 'maintenance' || this.counted.has(key) || targets.length === 0) return;
    const requested = targets.map((target) => previous.get(targetKey(target)));
    if (
      !requested.every((result) => result?.success) ||
      !requested.some((result) => result?.outcome === 'installed')
    )
      return;
    this.counted.add(key);
    try {
      await updatePersonalSkill(locator, { increment: true });
    } catch (error) {
      // Installed files remain successful; personal-state errors must never contaminate JSON stdout.
      console.error(
        `Installed ${locator.name}, but could not save personal history: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

export async function recordCompletedSkills(
  locators: SkillLocator[],
  targets: InstallTarget[],
  results: TargetInstallResult[],
  reason?: InstallReason
): Promise<void> {
  const completion = new InstallCompletion();
  for (const locator of locators) {
    await completion.record(
      locator,
      targets,
      results.filter((result) => result.skillName === locator.name),
      installationReason(reason)
    );
  }
}
