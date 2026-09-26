import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FilterRule {
  pattern: string;
  action: "block" | "allow";
}
export function filtersPath(dataDir: string): string {
  return join(dataDir, "filters.json");
}
export function readFilters(dataDir: string): FilterRule[] {
  const p = filtersPath(dataDir);
  if (!existsSync(p)) return [];
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(v) ? v.filter((r) => r && typeof r.pattern === "string" && (r.action === "block" || r.action === "allow")) : [];
  } catch {
    return [];
  }
}
export function addFilter(dataDir: string, rule: FilterRule): FilterRule[] {
  if (!rule.pattern || (rule.action !== "block" && rule.action !== "allow")) throw new Error("filter needs pattern and action block|allow");
  const rules = readFilters(dataDir);
  if (!rules.some((r) => r.pattern === rule.pattern && r.action === rule.action)) rules.push({ pattern: rule.pattern, action: rule.action });
  writeFileSync(filtersPath(dataDir), JSON.stringify(rules, null, 2) + "\n");
  return rules;
}
