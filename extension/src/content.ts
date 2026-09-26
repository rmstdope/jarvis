import { Readability } from "@mozilla/readability";

interface Extracted { title: string; content: string; byline?: string; }

function youtubeMarkdown(): Extracted {
  const t = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? "";
  const title = t("h1.ytd-watch-metadata, h1 yt-formatted-string") || document.title;
  const channel = t("#owner #channel-name a, ytd-channel-name a");
  const info = t("#info-container, #info");
  const desc = t("#description-inline-expander, #description");
  const chapters = [...document.querySelectorAll("ytd-macro-markers-list-item-renderer #details h4")].map((e) => `- ${e.textContent?.trim()}`).join("\n");
  const links = [...document.querySelectorAll("#description a[href]")].map((a) => `- ${(a as HTMLAnchorElement).href}`).slice(0, 30).join("\n");
  const md = [`# ${title}`, channel ? `Channel: ${channel}` : "", info, chapters ? `## Chapters\n${chapters}` : "", desc ? `## Description\n${desc}` : "", links ? `## Links\n${links}` : ""].filter(Boolean).join("\n\n");
  return { title, content: md, byline: channel || undefined };
}
export function extract(): Extracted {
  if (/(^|\.)youtube\.com$/.test(location.hostname) && location.pathname === "/watch") return youtubeMarkdown();
  try {
    const art = new Readability(document.cloneNode(true) as Document).parse();
    if (art?.content) return { title: art.title || document.title, content: art.content, byline: art.byline ?? undefined };
  } catch {}
  return { title: document.title, content: document.body.innerHTML };
}

chrome.runtime.onMessage.addListener((msg: { type: string }, _s, reply) => {
  if (msg.type === "extract") reply(extract());
  return false;
});

// Floating action button in a closed shadow root: "Block" when auto-capture is on, else "Capture" (bypasses the blocklist).
(async () => {
  if (window.top !== window) return;
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483647;opacity:.35;transition:opacity .2s";
  host.onmouseenter = () => (host.style.opacity = "1");
  host.onmouseleave = () => (host.style.opacity = ".35");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = "button{font:12px system-ui;padding:6px 10px;border-radius:999px;border:1px solid #d9dee7;background:#fff;color:#161b26;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.15)} @media print{button{display:none}}";
  const btn = document.createElement("button");
  root.append(style, btn);
  const refresh = async () => {
    const st = (await chrome.runtime.sendMessage({ type: "getPageState", url: location.href })) as { autoCapture: boolean; captured: boolean; blocked: boolean };
    btn.textContent = st.autoCapture ? (st.blocked ? "Blocked" : "Block") : st.captured ? "✓ Captured" : "Capture";
    btn.onclick = async () => {
      if (st.autoCapture) await chrome.runtime.sendMessage({ type: "addBlockRule", url: location.href });
      else await chrome.runtime.sendMessage({ type: "captureNow", url: location.href, bypassBlocklist: true });
      setTimeout(refresh, 800);
    };
  };
  document.documentElement.appendChild(host);
  refresh().catch(() => host.remove());
})();
