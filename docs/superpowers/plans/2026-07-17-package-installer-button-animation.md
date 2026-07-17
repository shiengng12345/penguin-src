# Package Installer Button Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a spinning loader in the package install button for the duration of an active installation.

**Architecture:** Reuse the existing `isInstalling` state and imported Lucide `Loader2` icon inside `PackageInstaller`. Change only the footer icon rendering; keep all button state and label logic intact.

**Tech Stack:** React 19, TypeScript, Lucide React, Tailwind CSS, Node test runner

---

### Task 1: Animate the install button icon

**Files:**
- Modify: `src/components/packages/PackageInstaller.tsx:1058`
- Test: `tests/package-spec.test.mjs`

- [x] **Step 1: Write the failing test**

Add this source-level regression test beside the existing `PackageInstaller` assertions:

```javascript
test("PackageInstaller spins a loader in the install button while installing", async () => {
  const source = await readFile(
    new URL("../src/components/packages/PackageInstaller.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /isInstalling\s*\?\s*\(\s*<Loader2 className="h-4 w-4 animate-spin" \/>\s*\)\s*:\s*\(\s*<Download className="h-4 w-4" \/>\s*\)/,
  );
});
```

- [x] **Step 2: Run the focused test to verify it fails**

Run:

```bash
rtk test node --test --test-reporter=spec tests/package-spec.test.mjs
```

Expected: FAIL because the install button always renders `Download`.

- [x] **Step 3: Implement the minimal conditional icon**

Replace the static icon in the footer button with:

```tsx
{isInstalling ? (
  <Loader2 className="h-4 w-4 animate-spin" />
) : (
  <Download className="h-4 w-4" />
)}
```

Do not alter `disabled={!canInstall}` or the existing label expression.

- [x] **Step 4: Run focused and full verification**

Run:

```bash
rtk test node --test --test-reporter=spec tests/package-spec.test.mjs
rtk pnpm test
rtk pnpm typecheck
rtk git diff --check
```

Expected: all commands exit 0 with no test failures, type errors, or whitespace errors.

- [x] **Step 5: Commit the implementation**

```bash
rtk git add src/components/packages/PackageInstaller.tsx tests/package-spec.test.mjs docs/superpowers/plans/2026-07-17-package-installer-button-animation.md
rtk git commit -m "feat(installer): animate install button progress"
```
