// broker-value.test.ts — direct unit tests for the shared "we do not know"
// presentation policy in broker-value.ts.
//
// formatWriteCapability (Stage 0 Task 2): capability.rs's `probe_write` used
// to create-then-delete a real topic just to learn `can_write`, which the
// product spec forbids (B-07, §11.9, §14.3). Write capability is now
// inferred from read-only responses instead, and `canWriteProbed` exists
// precisely so the UI can tell "measured as unwritable" apart from "never
// measured" — this must never collapse into a single "cannot write" string.
import { describe, expect, it } from "vitest";
import { formatWriteCapability } from "../broker-value";

describe("formatWriteCapability", () => {
  it('reads "Not measured" when the read probe never conclusively answered', () => {
    // canWrite is always false when unprobed — this is the case a
    // successful read (or an inconclusive failure) leaves behind.
    expect(formatWriteCapability(false, false)).toBe("Not measured");
  });

  it('never reads "cannot write" for an unmeasured connection', () => {
    const text = formatWriteCapability(false, false).toLowerCase();
    expect(text).not.toContain("cannot write");
    expect(text).not.toContain("can't write");
  });

  it('reads "Cannot write" only when a 401/403 conclusively measured it', () => {
    expect(formatWriteCapability(false, true)).toBe("Cannot write");
  });

  it('reads "Can write" for the one state where a write was conclusively possible', () => {
    expect(formatWriteCapability(true, true)).toBe("Can write");
  });
});
