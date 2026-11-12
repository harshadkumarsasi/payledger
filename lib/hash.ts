import { createHash } from "node:crypto";

/**
 * Stable JSON stringification: object keys are sorted, arrays keep their order.
 * This is what makes retries with reordered JSON keys (but the same values)
 * hash identically.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function hashRequest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}
