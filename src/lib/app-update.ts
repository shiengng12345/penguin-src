export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const STARTUP_UPDATE_CHECK_DELAY_MS = 5 * 1000;

interface ScheduledUpdateCheckInput {
  nowMs: number;
  lastCheckedAt: string | null;
}

interface UpdateCheckInput extends ScheduledUpdateCheckInput {
  manual: boolean;
}

interface UpdateBadgeInput {
  updateVersion: string | null;
  dismissedVersion: string | null;
}

interface ReleaseWelcomeInput {
  currentVersion: string;
  lastSeenVersion: string | null;
}

export function shouldShowReleaseWelcome({
  currentVersion,
  lastSeenVersion,
}: ReleaseWelcomeInput): boolean {
  const version = currentVersion.trim();
  return version.length > 0 && version !== lastSeenVersion;
}

export function shouldRunScheduledUpdateCheck({
  nowMs,
  lastCheckedAt,
}: ScheduledUpdateCheckInput): boolean {
  if (!lastCheckedAt) return true;

  const lastCheckedMs = Date.parse(lastCheckedAt);
  if (!Number.isFinite(lastCheckedMs)) return true;

  return nowMs - lastCheckedMs >= UPDATE_CHECK_INTERVAL_MS;
}

export function shouldRunUpdateCheck({
  nowMs,
  lastCheckedAt,
  manual,
}: UpdateCheckInput): boolean {
  if (manual) return true;
  return shouldRunScheduledUpdateCheck({ nowMs, lastCheckedAt });
}

export function shouldShowUpdateBadge({
  updateVersion,
  dismissedVersion,
}: UpdateBadgeInput): boolean {
  return Boolean(updateVersion && updateVersion !== dismissedVersion);
}

export function normalizeUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  if (
    normalized.includes("fetch") ||
    normalized.includes("release") ||
    normalized.includes("remote")
  ) {
    return "Unable to reach the update feed. Publish the GitHub release and make sure latest.json is reachable.";
  }

  return message;
}
