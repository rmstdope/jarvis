import { existsSync } from "node:fs";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git non-interactively: never prompt for credentials. */
export function git(cwd: string, args: string[]): GitResult {
  if (!existsSync(cwd)) return { code: 128, stdout: "", stderr: `fatal: cannot change to '${cwd}': No such file or directory` };
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "true" },
  });
  return { code: p.exitCode, stdout: new TextDecoder().decode(p.stdout).trim(), stderr: new TextDecoder().decode(p.stderr).trim() };
}
export function gitOk(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
export function isWorkTree(cwd: string): boolean {
  const r = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout === "true";
}
export function hasRemote(cwd: string): boolean {
  return git(cwd, ["remote"]).stdout.length > 0;
}
export function hasIdentity(cwd: string): boolean {
  return git(cwd, ["config", "user.name"]).stdout.length > 0 && git(cwd, ["config", "user.email"]).stdout.length > 0;
}
export function unresolvedConflicts(cwd: string): string[] {
  const r = git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
  return r.stdout ? r.stdout.split("\n").filter(Boolean) : [];
}
export function headCommit(cwd: string): string | null {
  const r = git(cwd, ["rev-parse", "HEAD"]);
  return r.code === 0 ? r.stdout : null;
}
