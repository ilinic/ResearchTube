import icon from "../../extension/icons/researchtube-128.png";
import { origin, type Env } from "./types";

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const copyIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"/></svg>';
const style = `
:root{color-scheme:dark;--bg:#1b1f23;--card:#22272e;--text:#e6edf3;--muted:#a9b4c0;--border:#444c56;--link:#58a6ff}*{box-sizing:border-box}body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:44px auto;padding:0 24px;color:var(--text);background:var(--bg)}
.brand{display:flex;align-items:center;gap:12px}.brand img{width:36px;height:36px;flex:none}h1{font-size:36px;line-height:1.2;letter-spacing:-.035em;margin:0;font-weight:650}
.tagline{font-size:22px;margin:14px 0 8px}.intro{color:var(--muted);margin:0 0 32px}section{margin-top:20px;padding:24px 26px;border:1px solid var(--border);border-radius:10px;background:var(--card)}h2{font-size:19px;line-height:1.4;margin:0 0 10px}p{margin:10px 0}
a{color:var(--link);text-decoration-thickness:1px;text-underline-offset:3px}a:hover{color:var(--muted)}.action{display:inline-block;margin-top:4px;font-weight:550}
.fields{margin:20px 0 0;border-top:1px solid var(--border)}.field{display:grid;grid-template-columns:130px minmax(0,1fr);gap:16px;border-bottom:1px solid var(--border);padding:12px 0}
dt{color:var(--muted)}dd{margin:0;display:flex;align-items:center;gap:12px;justify-content:space-between;min-width:0}.value{overflow-wrap:anywhere}code{font:14px/1.6 ui-monospace,monospace}
.copy{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border:0;border-radius:6px;background:transparent;color:var(--muted);cursor:pointer;padding:6px}
.copy:hover{background:#58a6ff1f;color:var(--text)}.copy:focus-visible,a:focus-visible{outline:2px solid var(--link);outline-offset:3px}.copy:disabled{opacity:.5;cursor:wait}
.hint{font-size:14px;color:var(--muted);margin-top:12px}#copy-status{min-height:24px;font-size:14px;color:var(--muted);margin:12px 0 28px}
@media(max-width:480px){body{margin-top:32px;padding:0 20px}h1{font-size:30px}.brand img{width:30px;height:30px}.tagline{font-size:20px}.field{grid-template-columns:100px minmax(0,1fr);gap:12px}section{padding:18px 16px}}
`;

export function homePage(env: Env): Response {
  const field = (label: string, value: string, code = false) => `<div class="field"><dt>${escape(label)}</dt><dd><${code ? "code" : "span"} class="value">${escape(value)}</${code ? "code" : "span"}><button type="button" class="copy" data-copy="${escape(value)}" data-label="${escape(label)}" aria-label="Copy ${escape(label)}" title="Copy ${escape(label)}">${copyIcon}</button></dd></div>`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Turn YouTube into answers with ResearchTube for ChatGPT."><title>ResearchTube — Turn YouTube into answers</title><link rel="icon" type="image/png" href="/icons/researchtube-128.png"><style>${style}</style></head><body>
<header><div class="brand"><img src="/icons/researchtube-128.png" alt="" width="36" height="36"><h1>ResearchTube</h1></div><p class="tagline">Turn YouTube into answers</p><p class="intro">Find videos, explore transcripts and work with media files in ChatGPT.</p></header>
<main><section aria-labelledby="install"><h2 id="install">1. Install Extension and Local Agent</h2><p>The Chrome extension lets ChatGPT work with YouTube in your browser. The Local Agent adds downloads and tools for files on your computer.</p><a class="action" href="https://github.com/ilinic/ResearchTube/releases" target="_blank" rel="noreferrer">Open GitHub Releases</a><p class="hint">Download the latest release and extract the archive to a location of your choice.</p></section>
<section aria-labelledby="chatgpt"><h2 id="chatgpt">2. Add ResearchTube to ChatGPT</h2><p><a href="https://chatgpt.com/plugins" target="_blank" rel="noreferrer">Open ChatGPT Plugins</a> and add a custom MCP server. Use these details:</p>
<dl class="fields">${field("Server URL", origin(env), true)}${field("Name", "ResearchTube")}${field("Description", "Turn YouTube into answers")}${field("Authentication", "OAuth")}<div class="field"><dt>Icon</dt><dd><code class="value">icons/researchtube-64.png</code></dd></div></dl>
<p class="hint">Choose the icon from the installed ResearchTube folder.</p><p>Choose OAuth, sign in with Google and install the plugin.</p><p id="copy-status" role="status" aria-live="polite"></p></section></main><script src="/home-ui.js" defer></script></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" }
  });
}

export function homeIcon(): Response {
  return new Response(icon, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}

export function homeScript(): Response {
  return new Response(String.raw`
const status=document.getElementById('copy-status');
document.querySelectorAll('[data-copy]').forEach(button=>button.addEventListener('click',async()=>{
  button.disabled=true;
  try{
    await navigator.clipboard.writeText(button.dataset.copy);
    status.textContent=button.dataset.label+' copied.';
  }catch{
    status.textContent='Copy is unavailable. Select the value and copy it manually.';
  }finally{button.disabled=false;}
}));
`, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
