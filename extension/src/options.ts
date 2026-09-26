import { DEFAULT_SETTINGS, loadSettings } from "./api.ts";
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;
(async () => {
  const s = await loadSettings();
  $("serverUrl").value = s.serverUrl;
  $("dwell").value = String(Math.round(s.minDwellMs / 1000));
  $("save").onclick = async () => {
    const serverUrl = ($("serverUrl").value.trim() || DEFAULT_SETTINGS.serverUrl).replace(/\/+$/, "");
    const dwellSec = Math.min(60, Math.max(1, Number($("dwell").value) || 5));
    await chrome.storage.local.set({ serverUrl, minDwellMs: dwellSec * 1000 });
    document.getElementById("msg")!.textContent = "saved (changing the port also requires editing host_permissions in manifest.json)";
  };
})();
