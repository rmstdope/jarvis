export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}
/** `--flag value` or bare `--flag` (= true); everything else positional. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
export function flagStr(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}
export function flagBool(flags: ParsedArgs["flags"], name: string): boolean {
  const v = flags[name];
  return v === true || v === "true";
}
export function flagInt(flags: ParsedArgs["flags"], name: string, fallback?: number): number | undefined {
  const v = flags[name];
  if (v === undefined || v === true) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`);
  return n;
}
