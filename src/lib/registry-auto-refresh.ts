// The strict gate for registry auto-refresh. Background polling (and the green
// toggle actually doing anything) is allowed ONLY when all three hold:
//   - enabled:        the user's persisted toggle is on
//   - devModeEnabled:  developer mode is on
//   - hasValidToken:   a valid admin / super-admin dev token is present
// A persisted `enabled=true` is never sufficient on its own — if the token
// expires or dev mode is turned off, refresh must stop immediately. Every
// poller funnels through here so the rule can't drift between call sites.

export interface RegistryAutoRefreshGate {
  enabled: boolean;
  devModeEnabled: boolean;
  hasValidToken: boolean;
}

export function canBackgroundRefreshRegistry(gate: RegistryAutoRefreshGate): boolean {
  return gate.enabled && gate.devModeEnabled && gate.hasValidToken;
}

// Cadence: fast while the installer is OPEN (the admin is watching the list),
// relaxed while it's CLOSED (we only need to keep the cache warm).
export const REGISTRY_AUTO_REFRESH_OPEN_MS = 5_000;
export const REGISTRY_AUTO_REFRESH_BACKGROUND_MS = 30_000;
// On repeated fetch failures (registry down / offline) back off exponentially
// from the base cadence up to this cap, instead of hammering every 5s.
export const REGISTRY_AUTO_REFRESH_MAX_BACKOFF_MS = 60_000;

// Delay before the next poll: the base cadence when healthy (failures === 0),
// doubling per consecutive failure, capped. Pure so the backoff curve is
// unit-tested without timers.
export function nextRegistryPollDelay(baseMs: number, failures: number): number {
  const scaled = baseMs * 2 ** Math.max(0, failures);
  return Math.min(scaled, REGISTRY_AUTO_REFRESH_MAX_BACKOFF_MS);
}
