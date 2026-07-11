import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FrontendGrpcConfig {
  dispatcher: string;
  serviceEnumMap: Record<string, string>; // "NS.ENUM" → proto service
  wrappers: Record<string, string>;        // proto service → wrapper class name
}

export function loadFrontendGrpcConfig(repoRoot: string): FrontendGrpcConfig | null {
  try {
    const p = JSON.parse(readFileSync(join(repoRoot, ".penguin-frontend-grpc.json"), "utf8"));
    if (!p.dispatcher || typeof p.serviceEnumMap !== "object" || !p.serviceEnumMap) return null;
    return {
      dispatcher: p.dispatcher,
      serviceEnumMap: p.serviceEnumMap,
      wrappers: p.wrappers ?? {},
    };
  } catch {
    return null;
  }
}
