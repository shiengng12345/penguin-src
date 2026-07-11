import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FrontendGrpcConfig {
  dispatcher: string;
  serviceEnumMap: Record<string, string>; // "NS.ENUM" → proto service
  wrappers: Record<string, string>;        // proto service → wrapper class name
  // Native method-name uniqueness mode: facade wrappers whose methods span
  // MULTIPLE backend proto services, so there is no single enum→service
  // mapping. `enums` are the service-enum members (as written at call sites)
  // that must be resolved by METHOD NAME instead; `wrappers` are the facade
  // class names whose sole-forward static methods form the verified set for
  // those calls. Optional/absent → feature is off (backward compatible).
  methodNameResolution?: { enums: string[]; wrappers: string[] };
}

export function loadFrontendGrpcConfig(repoRoot: string): FrontendGrpcConfig | null {
  try {
    const p = JSON.parse(readFileSync(join(repoRoot, ".penguin-frontend-grpc.json"), "utf8"));
    if (!p.dispatcher || typeof p.serviceEnumMap !== "object" || !p.serviceEnumMap) return null;
    const mnr = p.methodNameResolution;
    const methodNameResolution =
      mnr && Array.isArray(mnr.enums) && Array.isArray(mnr.wrappers)
        ? { enums: mnr.enums as string[], wrappers: mnr.wrappers as string[] }
        : undefined;
    return {
      dispatcher: p.dispatcher,
      serviceEnumMap: p.serviceEnumMap,
      wrappers: p.wrappers ?? {},
      methodNameResolution,
    };
  } catch {
    return null;
  }
}
