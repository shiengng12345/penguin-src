/** Public CLI boundary.
 *
 * Command implementations live in `command-dispatch.ts`; this module keeps
 * the stable package surface and the single dispatch entry point used by the
 * binary, Tauri bridge, tests, and MCP local fallback.
 */
import { dispatchCliCommand, type CliDeps } from "./command-dispatch.js";
import { parseCliArguments } from "./args.js";

export type { CliDeps } from "./command-dispatch.js";
export { parseCliArguments, type ParsedCliArguments } from "./args.js";
export { listCliRegistrations } from "@penguin/knowledge-contracts";
export { LarkDocumentBindingStore, type LarkDocumentBinding, type ExplicitBindingInput, type LarkBindingCandidate } from "./api-doc-binding-store.js";

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  return dispatchCliCommand(argv, deps, parseCliArguments(argv));
}
