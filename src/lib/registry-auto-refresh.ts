// The strict gate for registry auto-refresh. Background polling (and the green
// toggle actually doing anything) is allowed ONLY when all three hold:
//   - enabled:        the user's persisted toggle is on
//   - devModeEnabled:  developer mode is on
//   - hasValidToken:   a valid admin / super-admin dev token is present
// A persisted `enabled=true` is never sufficient on its own — if the token
// expires or dev mode is turned off, refresh must stop immediately. Both the
// installer's own poll and the app-level background poller funnel through here
// so the rule can't drift between the two call sites.

export interface RegistryAutoRefreshGate {
  enabled: boolean;
  devModeEnabled: boolean;
  hasValidToken: boolean;
}

export function canBackgroundRefreshRegistry(gate: RegistryAutoRefreshGate): boolean {
  return gate.enabled && gate.devModeEnabled && gate.hasValidToken;
}

export const REGISTRY_AUTO_REFRESH_INTERVAL_MS = 30_000;
