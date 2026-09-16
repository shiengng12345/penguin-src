//! Topology cache policy.
//!
//! Pulsar's Admin REST ignores pagination and always returns full lists, so
//! the module caches those lists and pages over the cache in Rust. What is
//! NOT cached is as important as what is: stats, subscriptions and consumers
//! are the live numbers an operator reads during triage, and a cached backlog
//! figure is not slightly-old information — it is actively misleading
//! (spec ruling D-A2).

use std::time::Duration;

/// The kinds of topology data that are cached. The string form is the
/// `scope` column in `broker_topology_snapshots`, so it is part of the
/// on-disk format — see the test that pins it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheScope {
    Tenants,
    Namespaces,
    Topics,
}

impl CacheScope {
    pub fn ttl(&self) -> Duration {
        match self {
            // Tenants and namespaces are structural; they change when someone
            // provisions something, not during an incident.
            CacheScope::Tenants => Duration::from_secs(300),
            CacheScope::Namespaces => Duration::from_secs(300),
            // A topic list can change under you while you are looking at it.
            CacheScope::Topics => Duration::from_secs(60),
        }
    }

    pub fn scope_name(&self) -> &'static str {
        match self {
            CacheScope::Tenants => "tenants",
            CacheScope::Namespaces => "namespaces",
            CacheScope::Topics => "topics",
        }
    }

    /// The singular noun for prose. Distinct from `scope_name()`, which is the
    /// database key and must not change to suit a sentence.
    pub fn subject(&self) -> &'static str {
        match self {
            CacheScope::Tenants => "tenant",
            CacheScope::Namespaces => "namespace",
            CacheScope::Topics => "topic",
        }
    }
}

/// How old a cached entry is relative to its scope's TTL.
///
/// `Stale` and `Skewed` still carry their data to the caller: the UI renders
/// the rows AND a notice, because hiding data an operator can still reason
/// about is worse than marking it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freshness {
    Fresh { age_ms: u64 },
    Stale { age_ms: u64 },
    /// The row is stamped ahead of this machine's clock, so its age cannot be
    /// computed at all. This is deliberately NOT folded into `Fresh { age_ms: 0 }`:
    /// that would hand the operator the most reassuring answer available at the
    /// exact moment the data is least trustworthy, and it would erase the only
    /// evidence that a clock somewhere is wrong. `ahead_ms` is how far ahead.
    Skewed { ahead_ms: u64 },
    Absent,
}

pub fn assess(scope: CacheScope, observed_at_ms: Option<i64>, now_ms: i64) -> Freshness {
    let Some(observed) = observed_at_ms else {
        return Freshness::Absent;
    };
    // A row stamped ahead of us has no computable age. Report the skew
    // instead of inventing an age for it. (`saturating_sub` is not what
    // protects this path — at epoch-millisecond magnitudes it is plain
    // subtraction; the explicit `observed > now_ms` branch below is. It stays
    // only to keep a pathological stored value from wrapping.)
    if observed > now_ms {
        let ahead_ms = observed.saturating_sub(now_ms).max(0) as u64;
        return Freshness::Skewed { ahead_ms };
    }
    let age_ms = now_ms.saturating_sub(observed).max(0) as u64;
    if age_ms <= scope.ttl().as_millis() as u64 {
        Freshness::Fresh { age_ms }
    } else {
        Freshness::Stale { age_ms }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn absent_when_nothing_was_cached() {
        assert_eq!(assess(CacheScope::Topics, None, NOW), Freshness::Absent);
    }

    #[test]
    fn fresh_inside_the_ttl() {
        // Topics TTL is 60s; 30s old is fresh.
        let observed = NOW - 30_000;
        assert_eq!(
            assess(CacheScope::Topics, Some(observed), NOW),
            Freshness::Fresh { age_ms: 30_000 }
        );
    }

    #[test]
    fn stale_past_the_ttl_but_still_reports_its_age() {
        // Past the TTL the data is still returned and rendered — the age is
        // what the UI shows next to the stale badge, so it must be accurate.
        let observed = NOW - 90_000;
        assert_eq!(
            assess(CacheScope::Topics, Some(observed), NOW),
            Freshness::Stale { age_ms: 90_000 }
        );
    }

    #[test]
    fn tenants_tolerate_a_much_longer_ttl_than_topics() {
        // Tenants change almost never; topics change often enough that a
        // minute-old list can already mislead.
        let four_minutes = NOW - 240_000;
        assert!(matches!(
            assess(CacheScope::Tenants, Some(four_minutes), NOW),
            Freshness::Fresh { .. }
        ));
        assert!(matches!(
            assess(CacheScope::Topics, Some(four_minutes), NOW),
            Freshness::Stale { .. }
        ));
    }

    #[test]
    fn a_timestamp_ahead_of_our_clock_is_reported_as_skew_not_as_fresh() {
        // A row stamped in the future means some clock is wrong, and the age
        // of that row is therefore unknowable. Reporting it as `Fresh` with a
        // zero age would hand the operator the single most reassuring answer
        // available at the exact moment the data is least trustworthy.
        let observed = NOW + 5_000;
        assert_eq!(
            assess(CacheScope::Topics, Some(observed), NOW),
            Freshness::Skewed { ahead_ms: 5_000 }
        );
    }

    #[test]
    fn skew_is_reported_for_every_scope_because_it_is_a_clock_fault_not_a_ttl_one() {
        // The TTL is irrelevant when the timestamp itself cannot be trusted,
        // so a long-TTL scope must not absorb skew into `Fresh`.
        let observed = NOW + 5_000;
        assert_eq!(
            assess(CacheScope::Tenants, Some(observed), NOW),
            Freshness::Skewed { ahead_ms: 5_000 }
        );
    }

    #[test]
    fn an_identical_timestamp_is_fresh_not_skewed() {
        // The skew boundary is strictly-ahead. A row written in the same
        // millisecond is ordinary, and must not be flagged.
        assert_eq!(
            assess(CacheScope::Topics, Some(NOW), NOW),
            Freshness::Fresh { age_ms: 0 }
        );
    }

    #[test]
    fn scope_names_are_stable_because_they_are_database_keys() {
        // These strings are the `scope` column in broker_topology_snapshots.
        // Renaming one orphans every cached row for that scope.
        assert_eq!(CacheScope::Tenants.scope_name(), "tenants");
        assert_eq!(CacheScope::Namespaces.scope_name(), "namespaces");
        assert_eq!(CacheScope::Topics.scope_name(), "topics");
    }
}
