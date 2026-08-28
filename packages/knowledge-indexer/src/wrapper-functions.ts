import type { Node } from "web-tree-sitter";

// Which callback-taking calls actually produce a function.
//
// The tags query captures `const X = someCall(callback)` as a function
// definition so that HOC- and hook-wrapped components are indexed:
// `const C = React.memo(...)`, `const h = useCallback(...)`. But the pattern
// fires on ANY call taking a callback, so every `.filter()` / `.find()` /
// `renderHook()` assigned to a const became a phantom "function" named after
// the binding — 5,670 of 48,863 function symbols (11.6%) across 26 repos.
//
// An allowlist, not a denylist of array methods: a denylist is a maintenance
// treadmill (every new array/promise/RxJS method silently reintroduces the
// bug), while an allowlist fails closed — an unlisted wrapper is recorded as a
// plain variable, which is a far smaller error than mislabelling an array as a
// function.
//
// Kept deliberately small. useMemo is EXCLUDED: it returns whatever the
// callback returns, so `const items = useMemo(() => arr.filter(...), [])` is an
// array while `const fn = useMemo(() => () => {}, [])` is a function, and the
// call site cannot tell them apart.
// Sized against what the real index actually contains, not guesswork: the
// callees below each produce hundreds of genuine function symbols across 26
// repos. createAsyncThunk matters for a second reason — the thunk must exist
// as a symbol or the gRPC calls inside its callback lose their enclosing
// scope and those edges disappear entirely.
const WRAPPER_NAMES = new Set([
  // React / component wrappers
  "memo",
  "forwardRef",
  "lazy",
  "observer",
  "withRouter",
  // React hooks that return the callback itself
  "useCallback",
  // Redux Toolkit: returns a callable thunk (210 in this index)
  "createAsyncThunk",
  "createAction",
  "connect",
  // Test doubles: callable by construction (jest.fn + jest.spyOn ~ 200)
  "fn",
  "spyOn",
  "mockImplementation",
  // Function combinators
  "debounce",
  "throttle",
  "memoize",
  "once",
  "curry",
  "partial",
  "bind",
]);

// Callees that take a callback and return something else. These are not
// needed for correctness (an unlisted callee is already excluded) — they exist
// so the intent is documented and a future edit does not "helpfully" add them:
//   Array.from, Object.entries/keys/values, setTimeout/setInterval,
//   useMemo (returns whatever the callback returns), renderHook,
//   and every array/promise method (.map/.filter/.find/.reduce/.then/...).

/** Bare name or member property that identifies a function-returning wrapper. */
export function isFunctionReturningWrapper(callee: string): boolean {
  if (WRAPPER_NAMES.has(callee)) return true;
  // `React.memo`, `_.debounce`, `lodash.throttle` — match on the property, so
  // the namespace an app happens to use does not matter. Matching the property
  // (not "any member expression") is what keeps React.memo working while
  // `config.plugins.find` and `children.filter` stay out.
  const property = callee.slice(callee.lastIndexOf(".") + 1);
  return property !== callee && WRAPPER_NAMES.has(property);
}

/**
 * For a captured `@definition.function` node, decide whether it is the
 * `const X = call(callback)` shape and, if so, whether that call returns a
 * function. Returns null when the node is not that shape at all (a plain
 * function declaration or arrow), so callers keep it unconditionally.
 */
export function wrappedFunctionVerdict(node: Node): { wrapped: true; returnsFunction: boolean } | null {
  if (node.type !== "variable_declarator") return null;
  const value = node.childForFieldName("value");
  if (!value || value.type !== "call_expression") return null;
  const callee = value.childForFieldName("function");
  if (!callee) return null;
  return { wrapped: true, returnsFunction: isFunctionReturningWrapper(callee.text) };
}
