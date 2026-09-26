import { Api, loadSettings, type ItemSummary } from "./api.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = <T>(msg: Record<string, unknown>) => chrome.runtime.sendMessage(msg) as Promise<T>;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

async function main() {
  const s = await loadSettings();
  const api = new Api(s.serverUrl);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? "";
  const status = await send<{ online: boolean; docs: number; autoCapture: boolean }>({ type: "getStatus" });
  $("dot").className = `dot ${status.online ? "on" : "off"}`;
  $("status").textContent = status.online ? `${status.docs} items · auto-capture ${status.autoCapture ? "on" : "off"}` : "service offline (brain serve)";
  $("toggle").textContent = status.autoCapture ? "Disable auto-capture" : "Enable auto-capture";
  $("toggle").onclick = async () => { await send({ type: "toggleAutoCapture" }); location.reload(); };

  let item: ItemSummary | null = null;
  try { item = (await api.itemBySource(url)).item; } catch {}
  const draw = () => {
    $("captured").textContent = item ? `Captured: ${item.title}` : "Not yet captured";
    $("tags").innerHTML = (item?.tags ?? []).map((t) => `<span class="chip">${esc(t)}</span>`).join("");
  };
  draw();
  const ensure = async () => {
    if (item) return item;
    const r = await send<{ id?: string; error?: string }>({ type: "captureNow", tabId: tab.id, url, bypassBlocklist: true });
    if (!r.id) throw new Error(r.error ?? "capture failed");
    item = (await api.itemBySource(url)).item;
    draw();
    return item!;
  };
  $("capture").onclick = () => ensure().then(draw, (e) => ($("msg").textContent = e.message));
  $("update").onclick = async () => { const r = await send<{ status?: string; error?: string }>({ type: "forceUpdate", tabId: tab.id, url }); $("msg").textContent = r.status ?? r.error ?? ""; };
  $("star").onclick = async () => { const r = await send<{ status?: string; error?: string }>({ type: "star", tabId: tab.id, url }); $("msg").textContent = r.status ? "starred" : r.error ?? ""; };
  $("saveContext").onclick = async () => {
    try {
      const it = await ensure();
      const ctx = $<HTMLTextAreaElement>("context").value.trim();
      const tags = $<HTMLInputElement>("newTags").value.split(",").map((x) => x.trim()).filter(Boolean);
      if (ctx) await api.setContext(it.id, ctx);
      if (tags.length) await api.setTags(it.id, [...new Set([...(it.tags ?? []), ...tags])]);
      item = (await api.itemBySource(url)).item;
      draw();
      $("msg").textContent = "saved";
    } catch (e) { $("msg").textContent = (e as Error).message; }
  };
  $("visuals").setAttribute("disabled", "true");
  $("visuals").title = "Image analysis is not permitted";

  try {
    const recent = await api.recent(5);
    $("recent").innerHTML = recent.items.map((i) => `<li><a href="${s.serverUrl}/#/item/${i.id}" target="_blank">${esc(i.title)}</a> <span class="muted">${esc(i.source)}</span></li>`).join("");
  } catch {}

  let mode: "all" | "tasks" = "all";
  const results = $("results");
  const runSearch = async () => {
    const q = $<HTMLInputElement>("q").value.trim();
    results.innerHTML = "";
    try {
      if (mode === "tasks") {
        const { tasks } = await api.tasks();
        const list = tasks.filter((t) => !q || t.title.toLowerCase().includes(q.toLowerCase()));
        results.innerHTML = list.map((t) => `<li>${t.status === "done" ? "✓" : "○"} ${esc(t.title)} ${item ? `<button data-link="${t.id}">Link</button>` : ""}</li>`).join("") || "<li class='muted'>no tasks</li>";
      } else if (q) {
        const hits = await api.search(q, 8);
        results.innerHTML = hits.map((h) => `<li><a href="${s.serverUrl}/#/item/${h.docId}" target="_blank">${esc(h.title)}</a> <span class="muted">${esc(h.source)}</span> ${item ? `<button data-link="${h.docId}">Link</button>` : ""}</li>`).join("") || "<li class='muted'>no results</li>";
      }
    } catch (e) { results.innerHTML = `<li class="err">${esc((e as Error).message)}</li>`; }
    results.querySelectorAll<HTMLButtonElement>("button[data-link]").forEach((b) => (b.onclick = async () => {
      try { await api.link(item!.id, b.dataset.link!); b.textContent = "Linked"; b.disabled = true; } catch (e) { $("msg").textContent = (e as Error).message; }
    }));
  };
  $("q").oninput = runSearch;
  $("tabAll").onclick = () => { mode = "all"; runSearch(); };
  $("tabTasks").onclick = () => { mode = "tasks"; runSearch(); };
  $("newTask").onclick = async () => {
    const title = $<HTMLInputElement>("taskTitle").value.trim();
    if (!title) return;
    try { const r = await api.addTask(title, item?.id); $("msg").textContent = `task ${r.id} created${item ? " and linked" : ""}`; $<HTMLInputElement>("taskTitle").value = ""; } catch (e) { $("msg").textContent = (e as Error).message; }
  };
}
main().catch((e) => ($("msg").textContent = e.message));
