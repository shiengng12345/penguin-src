import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApiDocBinding } from "./lark-sync.js";

export class ApiDocBindingStore {
  constructor(private readonly path: string) { mkdirSync(dirname(path), { recursive: true }); }
  private read(): Record<string, ApiDocBinding> { if (!existsSync(this.path)) return {}; try { return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, ApiDocBinding>; } catch { return {}; } }
  private write(value: Record<string, ApiDocBinding>): void { const temp = `${this.path}.${process.pid}.tmp`; writeFileSync(temp, JSON.stringify(value, null, 2)); renameSync(temp, this.path); }
  get(documentKey: string): ApiDocBinding | null { return this.read()[documentKey] ?? null; }
  list(): ApiDocBinding[] { return Object.values(this.read()); }
  bind(binding: ApiDocBinding): ApiDocBinding { const all = this.read(); all[binding.documentKey] = binding; this.write(all); return binding; }
  unbind(documentKey: string, expectedNodeToken: string): void { const all = this.read(); if (all[documentKey] && all[documentKey].nodeToken !== expectedNodeToken) throw new Error("binding token mismatch"); delete all[documentKey]; this.write(all); }
}
