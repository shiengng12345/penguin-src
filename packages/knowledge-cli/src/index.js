/** Public CLI boundary.
 *
 * Command implementations live in `command-dispatch.ts`; this module keeps
 * the stable package surface and the single dispatch entry point used by the
 * binary, Tauri bridge, tests, and MCP local fallback.
 */
import { dispatchCliCommand } from "./command-dispatch.js";
import { parseCliArguments } from "./args.js";
export { parseCliArguments } from "./args.js";
export { listCliRegistrations } from "@penguin/knowledge-contracts";
export { LarkDocumentBindingStore } from "./api-doc-binding-store.js";
export async function runCli(argv, deps) {
    return dispatchCliCommand(argv, deps, parseCliArguments(argv));
}
//# sourceMappingURL=index.js.map