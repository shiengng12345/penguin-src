# Penguin index-quality quiz — findings

> Result of grading `index-quality-answers.md` against the real code.
> Repo under test: `FPMS-CCMS` (branch `brazil-v2`, commit `a30388f9`) · 2026-08-28
> Index: schemaVersion 14, parser `tree-sitter-wasm-v7-jsx-dynamic-edges`, clean worktree.

Every question's index answer was compared to the source with the verify command
from the answer key, then each suspicious entry was traced back to the Pengvi
source that produced it. Two real defects came out of it, both quantified
repo-wide against `~/.penguin/knowledge/knowledge.db`.

## Scoreboard

| # | Type | Verdict |
|---|---|---|
| Q1 | callers | ✅ 8/8 exact |
| Q2 | callers | ⚠️ correct, but test-file callers unattributed |
| Q3 | callers | ⚠️ correct, but test-file callers unattributed |
| Q4 | callers | ✅ 8/8 exact |
| Q5 | callees | ❌ 2 of 10 are phantom edges |
| Q6 | callees | ❌ 2 of 10 are phantom edges |
| Q7 | callees | ✅ 10/10 exact |
| Q8 | file_symbols | ✅ 12/12 exact |
| Q9 | file_symbols | ❌ 11 real + 1 phantom symbol |
| Q10 | file_symbols | ❌ 10 real + 2 phantom symbols |

What the passes prove is worth stating: caller sets are exact (Q1, Q4), calls
through 8 same-named `fetchTransformHandler` scopes dedupe correctly (Q2), and
members destructured out of a hook (`const { fetchComponent, multipleDelete } =
useComponentData()`) resolve to their real definitions in
`useComponentData.ts`, not to the destructuring site (Q7). Class methods,
object-literal arrow properties, and `useCallback`-wrapped handlers are all
picked up (Q8).

---

## Defect 1 — external-package imports resolve to same-named jest mocks

**Severity: high.** 8.9% of all call edges in the repo are wrong, concentrated
on five bogus mega-hubs.

`AmbassadorInfoForm` imports `useLocation` and `useParams` from
`react-router-dom`. The index points both call edges at the `jest.mock` factory
stubs in `src/views/MarketingCampaign/LandingPageConfig/components/SubmitBar.test.tsx`:

```ts
// SubmitBar.test.tsx:45
useLocation: () => ({}),
useParams:   () => ({}),
```

Q6 is the same bug wearing a different hat: `ArticlesForm` never imports
`useSearchState`, yet the index lists `src/common/useSearchState.ts:getFieldValue`
as a callee. The real `getFieldValue` there is antd's `Form` instance method and
the render-prop destructure at `ArticlesForm.tsx:1037`.

### Blast radius

Of 8,992 active `calls` edges on the branch, **797 (8.9%) run from production
code into a mock stub inside a test file**. Five names account for 783 of them:

| Callee | Resolved to | Callers |
|---|---|---|
| `useSelector` | `src/views/ResourceManagement/hooks/useResourceData.test.ts` | 337 |
| `useDispatch` | `src/views/ResourceManagement/hooks/useResourceData.test.ts` | 156 |
| `useNavigate` | `src/views/MarketingCampaign/LandingPageConfig/components/SubmitBar.test.tsx` | 125 |
| `useLocation` | `src/views/MarketingCampaign/LandingPageConfig/components/SubmitBar.test.tsx` | 91 |
| `useParams` | `src/views/MarketingCampaign/LandingPageConfig/components/SubmitBar.test.tsx` | 74 |

```sql
-- reproduce
WITH sv AS (SELECT node_id, MIN(file_path) file_path FROM symbol_versions
            WHERE branch_id='branch_b3caf9bc-920b-43ac-85ad-009582a5d607' GROUP BY node_id)
SELECT n.title, d.file_path, COUNT(*) callers
FROM edges e
JOIN sv s ON s.node_id=e.src JOIN sv d ON d.node_id=e.dst JOIN nodes n ON n.id=e.dst
WHERE e.edge_type='calls' AND e.status='active'
  AND (d.file_path LIKE '%.test.%' OR d.file_path LIKE '%.spec.%')
  AND s.file_path NOT LIKE '%.test.%' AND s.file_path NOT LIKE '%.spec.%'
GROUP BY e.dst ORDER BY callers DESC;
```

These are not low-confidence guesses — they are stored as `EXTRACTED`, the
highest confidence tier, so nothing downstream flags them.

### Root cause

`packages/knowledge-indexer/src/resolve.ts:260`, resolution tier 3b:

```ts
// tier 3b: unique same-repo bare hit.
if (candidates.length === 1) {
  push(src, candidates[0].id, edgeType, "EXTRACTED");
  continue;
}
```

`useSelector`'s only same-repo symbol is the test stub, so it is a unique bare
hit and gets a full-confidence edge. The resolver does carry import evidence,
but `importedFiles` is a set of *files* — a bare specifier like `'react-redux'`
never lands in it, so import scoping (tier 3a) abstains and control falls
straight through to 3b.

The `GENERIC_NAMES` guard at `resolve.ts:48` exists for exactly this failure
shape, but it only covers builtin-ish names (`get`, `map`, `error`, …). Library
hook names are not on it, and enumerating them never would be.

### Suggested fix

Before tier 3b, check whether the call site's file has an import binding for the
bare name whose specifier does not resolve to a repo file. If so, the callee is
external — drop the edge rather than falling through. This needs the extractor
to keep import *bindings* (name → specifier), not just the resolved file set.

---

## Defect 2 — `const X = someCall(callback)` is always indexed as a function

**Severity: medium.** 11% of `function` symbols are actually arrays or objects.

Q9 lists `filtered (function)` in `src/utils/navTreeUtils.ts`. It is an array:

```ts
// navTreeUtils.ts:60
const filtered = children
  .filter((r) => !isDetailRoute(r.path) && (r.label || r.category || r.childCategory))
  .sort((a, b) => { ... });
```

Q10 lists `a (function)` and `b (function)`. They are `RenderHookResult` objects:

```ts
// useAmbassadorVideoUpload.test.ts:345
const a = renderHook(() => useAmbassadorVideoUpload());
const b = renderHook(() => useAmbassadorVideoUpload());
```

### Blast radius

Of 5,679 `function` symbols on the branch, **623 (11%)** have a signature of the
form `const X = <array/utility call>(…callback…)` and are not functions:

```sql
SELECT COUNT(*) FROM symbol_versions
WHERE branch_id='branch_b3caf9bc-920b-43ac-85ad-009582a5d607' AND kind='function'
  AND (signature LIKE '%.filter(%' OR signature LIKE '%.map(%' OR signature LIKE '%.sort(%'
    OR signature LIKE '%.reduce(%' OR signature LIKE '%.find(%' OR signature LIKE '%renderHook(%'
    OR signature LIKE '%.forEach(%' OR signature LIKE '%.some(%' OR signature LIKE '%.every(%')
  AND signature NOT LIKE '%useCallback(%';
```

Samples: `covered = inventory.filter(...)`, `src = LANGS.find(...)`,
`eslintPlugin = config.plugins.find(...)`, `errorLines = lines.filter(...)`.

### Root cause

`packages/knowledge-indexer/src/queries.ts:26-29` (and the mirrored JS query at
:51-54):

```scheme
(variable_declarator
  name: (identifier) @name
  value: (call_expression
    arguments: (arguments [(arrow_function) (function_expression)]))) @definition.function
```

The pattern exists to capture HOC-wrapped components and hook-wrapped handlers,
and it does that job — `CustomInput = React.memo(...)`, `formValidator =
useCallback(...)`, `validateValue = useCallback(...)` are all correctly indexed
because of it (Q8 passes 12/12 on the strength of this rule). But it fires on
*any* call that takes a callback, so every `.filter()` / `.map()` / `.find()`
chain assigned to a const becomes a phantom function named after the binding.

### Suggested fix

Constrain the callee. Either allowlist the wrappers that genuinely return a
function (`memo`, `forwardRef`, `useCallback`, `debounce`, `throttle`,
`withRouter`, `observer`, …), or exclude `member_expression` callees whose
property is a known array/promise method. The allowlist is the safer of the two
— it fails closed.

---

## Not defects

Two things look like misses in the answer key but are defensible design.

**Test-file callers are unattributed (Q2, Q3).** `formUtils.test.ts` calls
`convertAction` four times and `playerService.test.ts` calls
`fetchPlayerLevelsForDisplay` three times, none of which appear as callers. All
seven sit inside anonymous `it('...', () => { ... })` callbacks, so the enclosing
scope has no name to attribute to. Structurally correct — but the consequence is
that "which tests cover this function" is unanswerable: `penguin context
AmbassadorInfoForm` returns `tests: 0`. Worth a separate decision about whether
`it`/`test`/`describe` callbacks should get synthetic named scopes.

**Callees inside nested callbacks are not on `calls` (Q5).**
`AmbassadorInfoForm` calls `generateBreadcrumbItems`, but from inside a
`useMemo(() => ...)`, so the edge belongs to `breadcrumbItems` and surfaces under
`invokesDynamic`, not `calls`. Same for `handleImageChange` and
`setFormValuesAndExecute` via their `…Wrapper` scopes. The layering is right;
reading `calls` alone just under-reports what a component ultimately reaches.

**No hidden cap of 10 on callees.** Q5/Q6/Q7 all returning exactly 10 is a
selection artifact of the quiz generator, not truncation — the `buildContextPack`
default is `limit = 25` (`packages/knowledge-core/src/query.ts:1521`), and
`GameFloorForm` returns 25, `PopupV2Form` 15, `ProbabilityConfigItemList` 11.
Note that `GameFloorForm` hitting exactly 25 *is* truncation at the default, with
no marker telling the caller the list was cut.

---

## Recommended order

1. **Defect 1** first — 797 bad edges concentrated on 5 symbols, and the fix is
   local to `resolve.ts` plus an extractor change to retain import bindings.
2. **Defect 2** second — larger symbol count affected, but the damage is
   cosmetic (a phantom entry in `file_symbols`) rather than a wrong edge.

Both require a full re-index of every repo after the change.
