import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cpus, totalmem, platform, arch } from "node:os";
import { parseModelsToml, writeModelsConfig } from "../providers/models.ts";

export const PRESETS_DIR = join(import.meta.dir, "..", "..", "docs", "examples", "models");

export function listPresets(): string[] {
  if (!existsSync(PRESETS_DIR)) return [];
  return readdirSync(PRESETS_DIR).filter((f) => f.endsWith(".toml")).map((f) => f.slice(0, -5)).sort();
}
export function readPreset(name: string): string {
  const p = join(PRESETS_DIR, `${name}.toml`);
  if (!existsSync(p)) throw new Error(`unknown preset "${name}" (available: ${listPresets().join(", ")})`);
  const text = readFileSync(p, "utf8");
  parseModelsToml(text); // validate
  return text;
}
export function applyPreset(name: string): string {
  const cfg = parseModelsToml(readPreset(name));
  return writeModelsConfig(cfg);
}

export interface Hardware {
  platform: string;
  arch: string;
  memoryGb: number;
  appleSilicon: boolean;
  nvidia: boolean;
  wsl: boolean;
  integratedGpu: boolean;
  cpuModel: string;
}
export function detectHardware(probe: { exists?: (p: string) => boolean; which?: (b: string) => string | null } = {}): Hardware {
  const exists = probe.exists ?? ((p: string) => existsSync(p));
  const which = probe.which ?? ((b: string) => Bun.which(b));
  const plat = platform();
  const a = arch();
  const wsl = plat === "linux" && (!!process.env.WSL_DISTRO_NAME || exists("/proc/sys/fs/binfmt_misc/WSLInterop"));
  const nvidia = which("nvidia-smi") !== null || (wsl && exists("/usr/lib/wsl/lib/libcuda.so.1"));
  const integratedGpu = wsl && exists("/dev/dxg") && exists("/usr/lib/wsl/lib/libd3d12.so");
  return { platform: plat, arch: a, memoryGb: Math.round(totalmem() / 1024 ** 3), appleSilicon: plat === "darwin" && a === "arm64", nvidia, wsl, integratedGpu, cpuModel: cpus()[0]?.model ?? "" };
}
/** Apple Silicon ≥ 30 GB → 32 GB preset, else 16 GB; Windows/Linux → copilot-only. */
export function recommendPreset(hw: Hardware): string {
  if (hw.appleSilicon) return hw.memoryGb >= 30 ? "mac-apple-silicon-32gb" : "mac-apple-silicon-16gb";
  return "copilot-only";
}
