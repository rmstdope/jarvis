import { createHash } from "node:crypto";

export function sha256(s: string | Uint8Array): string {
  return createHash("sha256").update(s).digest("hex");
}
export function nowIso(): string {
  return new Date().toISOString();
}
export function osUsername(): string {
  return process.env.USER ?? process.env.USERNAME ?? "unknown";
}
/** Truncate to EMBEDDING_DIMS and L2-normalize; round-trip through Float32Array. */
export function normalizeVector(v: number[] | Float32Array, dims: number): Float32Array {
  const out = new Float32Array(dims);
  const n = Math.min(dims, v.length);
  for (let i = 0; i < n; i++) out[i] = v[i];
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm);
  if (norm === 0) norm = 1;
  for (let i = 0; i < dims; i++) out[i] = out[i] / norm;
  return out;
}
export function vecToJson(v: Float32Array): string {
  return JSON.stringify(Array.from(v));
}
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
