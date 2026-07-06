const SNSOFT_PACKAGE_SPEC_RE = /^@snsoft\/(?:[\w-]+-(?:grpc-web|grpc)|js-sdk)@[\w.\-T]+$/;

export type SnsoftPackageProtocol = "grpc-web" | "grpc" | "sdk";

export function isAllowedSnsoftPackageSpec(spec: string): boolean {
  return SNSOFT_PACKAGE_SPEC_RE.test(spec.trim());
}

/**
 * Normalize copy-pasted package.json / yarn-lock / yaml-ish lines into the
 * canonical `<name>@<version>` spec the installer expects.
 *
 * Inputs handled:
 *   `"@snsoft/x": "1.0.0"`     → `@snsoft/x@1.0.0`   (package.json dependency entry)
 *   `"@snsoft/x": "1.0.0",`    → `@snsoft/x@1.0.0`   (trailing comma — package.json mid-list)
 *   `@snsoft/x: 1.0.0`         → `@snsoft/x@1.0.0`   (yaml-style, no quotes)
 *   `@snsoft/x@1.0.0`          → `@snsoft/x@1.0.0`   (already canonical — passthrough)
 *   anything else / partial    → returned as-is (caller validates later)
 *
 * The matcher is intentionally narrow — it only fires when both name and
 * version are obviously present so mid-typing doesn't mutate the input.
 */
/**
 * Strip semver range prefixes (^, ~, >=, <=, >, <, =) from a version string
 * so that `^3.0.1-20260706154846` becomes `3.0.1-20260706154846`.
 */
function stripVersionRange(version: string): string {
  return version.replace(/^[\^~><=]+\s*/, "");
}

export function normalizePackageSpec(input: string): string {
  const cleaned = input.trim().replace(/,\s*$/, "").trim();

  // 1. package.json style: "name": "version" (both halves quoted)
  const pj = cleaned.match(/^"([^"]+)"\s*:\s*"([^"]+)"$/);
  if (pj) return `${pj[1]}@${stripVersionRange(pj[2])}`;

  // 2. yaml-ish: name: version (no quotes). Restrict first char so we
  //    don't false-match canonical `@scope/name@1.2.3` (which contains no
  //    colon anyway, but defensive).
  const yaml = cleaned.match(/^(@?[\w/.-]+)\s*:\s*([\w.\-T]+)$/);
  if (yaml && !cleaned.includes("@", 1)) {
    // Reject if the supposed name part already contains an @ past pos 0 —
    // that means it's already canonical (@scope/x@1.2.3 doesn't have ':')
    // and shouldn't have matched, but belt + suspenders.
    return `${yaml[1]}@${stripVersionRange(yaml[2])}`;
  }

  // Already canonical or partial — pass through unchanged.
  return input;
}

export function snsoftPackageNameFromSpec(spec: string): string | null {
  const trimmed = spec.trim();
  if (!isAllowedSnsoftPackageSpec(trimmed)) return null;
  const atIdx = trimmed.lastIndexOf("@");
  return atIdx > 0 ? trimmed.slice(0, atIdx) : null;
}

export function protocolFromSnsoftPackageSpec(spec: string): SnsoftPackageProtocol | null {
  const name = snsoftPackageNameFromSpec(spec);
  if (!name) return null;
  if (name === "@snsoft/js-sdk") return "sdk";
  if (name.endsWith("-grpc-web")) return "grpc-web";
  if (name.endsWith("-grpc")) return "grpc";
  return null;
}
