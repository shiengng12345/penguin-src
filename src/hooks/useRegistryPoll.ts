import { useEffect } from "react";
import { fetchRegistryPackages } from "@/lib/registry-search";
import {
  nextRegistryPollDelay,
  REGISTRY_AUTO_REFRESH_BACKGROUND_MS,
} from "@/lib/registry-auto-refresh";

// Self-scheduling registry poller shared by the open-installer poll and the
// app-level background poll. Two properties fall out of the design:
//  - In-flight de-dup: each tick AWAITS its fetch before scheduling the next,
//    so a slow request can never stack overlapping fetches (the failure mode a
//    naive 5s setInterval hits on a slow network).
//  - Error backoff: consecutive failures double the delay up to a cap; the
//    first success resets to the base cadence.
// `active` is the strict gate — flip it false (toggle off, token expired, dev
// mode off, installer state change) and the loop tears down immediately.
export function useRegistryPoll(
  active: boolean,
  baseDelayMs: number = REGISTRY_AUTO_REFRESH_BACKGROUND_MS,
): void {
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;

    const run = async () => {
      try {
        await fetchRegistryPackages({ force: true });
        failures = 0;
      } catch {
        failures += 1;
      }
      if (cancelled) return;
      timer = setTimeout(run, nextRegistryPollDelay(baseDelayMs, failures));
    };

    void run(); // refresh right away when the loop becomes active
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, baseDelayMs]);
}
