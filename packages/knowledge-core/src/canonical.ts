import { createHash } from "node:crypto";

// 稳定序列化：对象键按字典序、丢弃 undefined 属性、数组保序。
// checksum（§2.2.2）建立在这个规范形之上，两次序列化必须逐字节一致。
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((k) => record[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${parts.join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Hash the canonical JSON representation without materializing the complete
 * document as one JavaScript string. Large corpus exports can exceed V8's
 * maximum string length even though every individual row is small.
 */
export function sha256Canonical(value: unknown): string {
  const hash = createHash("sha256");

  const update = (part: string): void => {
    hash.update(part, "utf8");
  };

  const visit = (current: unknown): void => {
    if (current === null || typeof current !== "object") {
      update(JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      update("[");
      current.forEach((entry, index) => {
        if (index > 0) update(",");
        visit(entry === undefined ? null : entry);
      });
      update("]");
      return;
    }

    const record = current as Record<string, unknown>;
    const keys = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined);
    update("{");
    keys.forEach((key, index) => {
      if (index > 0) update(",");
      update(JSON.stringify(key));
      update(":");
      visit(record[key]);
    });
    update("}");
  };

  visit(value);
  return hash.digest("hex");
}
