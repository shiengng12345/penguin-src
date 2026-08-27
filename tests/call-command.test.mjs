import assert from "node:assert/strict";
import { test } from "node:test";
import {
  packageCandidatesFromFullName,
  resolvePackage,
} from "../packages/knowledge-cli/dist/call-command.js";

test("resolvePackage accepts the exact conventional package", () => {
  assert.equal(
    resolvePackage(["player"], undefined, ["@snsoft/player-grpc-web"]),
    "@snsoft/player-grpc-web",
  );
});

test("resolvePackage returns the ACTUAL installed name on case mismatch", () => {
  // On case-sensitive filesystems the constructed lowercase name may not
  // exist on disk — the installed entry must win.
  assert.equal(
    resolvePackage(["player"], undefined, ["@snsoft/Player-grpc-web"]),
    "@snsoft/Player-grpc-web",
  );
});

test("resolvePackage rejects multiple fuzzy package matches", () => {
  assert.throws(
    () => resolvePackage(["player"], undefined, [
      "@snsoft/player-grpc-web-a",
      "@snsoft/player-grpc-web-b",
    ]),
    /matches several installed packages/,
  );
});

test("resolvePackage does not accept an unrelated substring match", () => {
  assert.throws(
    () => resolvePackage(["player"], undefined, ["@snsoft/footplayer"]),
    /No installed grpc-web package matches proto package/,
  );
});

test("resolvePackage lets an explicit package bypass discovery", () => {
  assert.equal(
    resolvePackage(["player"], "@custom/player-client", [
      "@snsoft/player-grpc-web-a",
      "@snsoft/player-grpc-web-b",
    ]),
    "@custom/player-client",
  );
});

// —— multi-segment proto packages (pengvi.auth.Auth.lookupNationalId) ————

test("packageCandidatesFromFullName covers full, last, and first segments", () => {
  assert.deepEqual(
    packageCandidatesFromFullName("pengvi.auth.Auth.lookupNationalId"),
    ["pengvi.auth", "auth", "pengvi"],
  );
  assert.deepEqual(
    packageCandidatesFromFullName("player.FrontendLoginConfigService.GetX"),
    ["player"],
  );
  assert.deepEqual(
    packageCandidatesFromFullName("health.v1.Health.Check"),
    ["health.v1", "v1", "health"],
  );
});

test("resolvePackage resolves multi-segment packages via the last segment", () => {
  assert.equal(
    resolvePackage(
      packageCandidatesFromFullName("pengvi.auth.Auth.lookupNationalId"),
      undefined,
      ["@snsoft/auth-grpc-web", "@snsoft/payment-grpc-web"],
    ),
    "@snsoft/auth-grpc-web",
  );
});

test("resolvePackage resolves the full dotted package when installed", () => {
  assert.equal(
    resolvePackage(
      packageCandidatesFromFullName("pengvi.auth.Auth.lookupNationalId"),
      undefined,
      ["@snsoft/pengvi-auth-grpc-web", "@snsoft/auth-grpc-web"],
    ),
    "@snsoft/pengvi-auth-grpc-web",
  );
});
