// mcp-former — single-page client.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let selectedTarget = null;
let lastDownloadable = null;   // {endpoint, filename}

// --- ANSI → HTML ----------------------------------------------------

const ANSI_MAP = {
  "0;32": "ansi-green",
  "0;31": "ansi-red",
  "1;33": "ansi-yellow",
  "0;36": "ansi-cyan",
  "2":    "ansi-dim",
};

function ansiToHtml(text) {
  let out = "";
  let i = 0;
  let openClass = null;
  while (i < text.length) {
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.indexOf("m", i);
      if (end < 0) { out += text[i++]; continue; }
      const code = text.slice(i + 2, end);
      if (code === "0") {
        if (openClass) { out += "</span>"; openClass = null; }
      } else {
        const cls = ANSI_MAP[code];
        if (openClass) out += "</span>";
        if (cls) {
          out += `<span class="${cls}">`;
          openClass = cls;
        } else {
          openClass = null;
        }
      }
      i = end + 1;
    } else {
      const c = text[i];
      out += (c === "<") ? "&lt;" :
             (c === ">") ? "&gt;" :
             (c === "&") ? "&amp;" : c;
      i++;
    }
  }
  if (openClass) out += "</span>";
  return out;
}

// --- tabs ---------------------------------------------------------------

$$(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.toggle(
      "active", x.dataset.tab === t.dataset.tab));
    $$(".tab-panel").forEach((p) => p.classList.toggle(
      "hidden", p.id !== `tab-${t.dataset.tab}`));
    if (t.dataset.tab === "registry") loadRegistryFull();
  });
});

// --- full registry tab ---------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let registryFullLoaded = false;
async function loadRegistryFull() {
  if (registryFullLoaded) return;
  const r = await fetch("/api/registry/index");
  if (!r.ok) {
    $("#registry-list").innerHTML =
      `<div class="preset-loading">registry unavailable (${r.status})</div>`;
    return;
  }
  const data = await r.json();
  const wrap = $("#registry-list");
  wrap.innerHTML = "";
  for (const w of data.wrappers) {
    const cats = (w.categories || [])
      .map(c => `<span class="reg-cat">${escapeHtml(c)}</span>`).join("");
    const gates = (w.gated_subcommands || [])
      .map(g => `<li>${escapeHtml(g)}</li>`).join("");
    const card = document.createElement("div");
    card.className = "reg-card";
    card.innerHTML = `
      <div class="reg-head">
        <span class="reg-name">${escapeHtml(w.name)}</span>
        <span class="reg-version">v${escapeHtml(w.version)}</span>
      </div>
      <p class="reg-desc">${escapeHtml(w.description)}</p>
      <div class="reg-meta">${cats}</div>
      <details>
        <summary>${(w.gated_subcommands || []).length} gated operations · ${w.ontology_facts || 0} facts</summary>
        <ul class="reg-gates">${gates}</ul>
      </details>
      <div class="reg-install">$ mcpf install ${escapeHtml(w.name)}</div>
    `;
    wrap.appendChild(card);
  }
  registryFullLoaded = true;
}

// --- registry + presets ---------------------------------------------

async function loadRegistry() {
  const r = await fetch("/api/registry");
  const data = await r.json();
  const container = $("#presets");
  container.innerHTML = "";
  for (const w of data.wrappers) {
    const div = document.createElement("div");
    div.className = "preset" + (w.status === "stub" ? " stub" : "");
    div.dataset.target = w.target;
    div.innerHTML = `
      <div class="name">
        ${w.name}
        <span class="badge ${w.status}">${w.status}</span>
      </div>
      <div class="desc">${w.description}</div>
    `;
    if (w.status === "ready") {
      div.addEventListener("click", () => selectTarget(w.target));
    }
    container.appendChild(div);
  }
}

function selectTarget(target) {
  selectedTarget = target;
  $$(".preset").forEach((el) => {
    el.classList.toggle("selected", el.dataset.target === target);
  });
  $("#plan-btn").disabled = false;
  $("#wrap-btn").disabled = false;
  $("#hint-builtin").textContent =
    `${target} selected — Plan shows the diff; Wrap builds the bundle.`;
}

// --- shared output handling ----------------------------------------

function showOutput(headerText) {
  $("#output-card").classList.remove("hidden");
  $("#output-actions").classList.add("hidden");
  $("#output").innerHTML = "";
  $("#output-status").textContent = "running…";
  $("#output-status").className = "status running";
  lastDownloadable = null;
}

function appendLine(html) {
  const out = $("#output");
  out.innerHTML += html + "\n";
  out.scrollTop = out.scrollHeight;
}

function setDoneStatus(ok) {
  $("#output-status").textContent = ok ? "done" : "error";
  $("#output-status").className = "status " + (ok ? "done" : "error");
}

function attachDownload(href, filename) {
  const link = $("#download-link");
  link.href = href;
  link.setAttribute("download", filename || "");
  $("#output-actions").classList.remove("hidden");
}

async function streamSSE(endpoint, body, frameHandlers) {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    appendLine(`<span class="ansi-red">request failed: ${resp.status}</span>`);
    setDoneStatus(false);
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    buf += decoder.decode(value, {stream: true});
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleFrame(frame, frameHandlers);
    }
  }
}

function handleFrame(frame, handlers) {
  const lines = frame.split("\n");
  let event = "message";
  let data = "";
  for (const ln of lines) {
    if (ln.startsWith("event:")) event = ln.slice(6).trim();
    else if (ln.startsWith("data:")) data += ln.slice(5).trimStart();
  }
  let payload;
  try { payload = JSON.parse(data); } catch { payload = data; }
  const fn = handlers[event];
  if (fn) fn(payload);
  else if (event === "log") appendLine(ansiToHtml(payload.line));
}

const baseHandlers = {
  start: (p) => appendLine(`<span class="ansi-dim">$ ${p.cmd}</span>`),
  log:   (p) => appendLine(ansiToHtml(p.line)),
  error: (p) => {
    appendLine(`<span class="ansi-red">${p.message || ""}</span>`);
    setDoneStatus(false);
  },
};

// --- 1. Plan flow (introspect for diff vs ontology) ----------------

async function runPlan() {
  if (!selectedTarget) return;
  const useLLM = $("#use-llm").checked;
  $("#plan-btn").disabled = true;
  $("#wrap-btn").disabled = true;
  showOutput();
  await streamSSE("/api/introspect",
    {target: selectedTarget, use_llm: useLLM},
    {
      ...baseHandlers,
      done: (p) => {
        const ok = p.exit_code === 0;
        setDoneStatus(ok);
        if (ok) {
          attachDownload(`/api/download/${p.target}`,
                          `mcp-former-${p.target}.zip`);
        }
        $("#hint-builtin").textContent = `${p.target} — ${ok ? "done" : "failed"}`;
        $("#plan-btn").disabled = false;
        $("#wrap-btn").disabled = false;
      },
    });
}

// --- 2. Wrap flow (full MCP bundle: adapter + ontology + server + skill) ---

async function runWrap(target) {
  $("#plan-btn").disabled = true;
  $("#wrap-btn").disabled = true;
  showOutput();
  await streamSSE("/api/wrap", {target},
    {
      ...baseHandlers,
      bundle_ready: (p) => {
        attachDownload(`/api/download-bundle/${p.token}`, p.filename);
        appendLine(
          `<span class="ansi-green">bundle ready — ` +
          `${p.filename}</span>`);
      },
      done: (p) => {
        const ok = p.exit_code === 0;
        setDoneStatus(ok);
        $("#plan-btn").disabled = false;
        $("#wrap-btn").disabled = false;
      },
    });
}

// --- 3. URL flow (paste github URL → wrap) ------------------------

async function runWrapURL() {
  const url = $("#github-url").value.trim();
  if (!url) {
    $("#hint-url").textContent = "paste a GitHub URL first";
    return;
  }
  if (!/^https?:\/\/github\.com\//.test(url)) {
    $("#hint-url").textContent = "must be a github.com URL";
    return;
  }
  const useLLM = $("#use-llm-url").checked;
  $("#wrap-url-btn").disabled = true;
  $("#hint-url").textContent = useLLM
    ? "cloning + LLM-generating ontology…"
    : "cloning + introspecting…";
  showOutput();
  await streamSSE("/api/wrap", {target: url, use_llm: useLLM},
    {
      ...baseHandlers,
      bundle_ready: (p) => {
        attachDownload(`/api/download-bundle/${p.token}`, p.filename);
        appendLine(
          `<span class="ansi-green">bundle ready — ` +
          `${p.filename}</span>`);
      },
      done: (p) => {
        const ok = p.exit_code === 0;
        setDoneStatus(ok);
        $("#wrap-url-btn").disabled = false;
        $("#hint-url").textContent =
          ok ? "edit the stub ontology to add real protections"
             : "failed — see output above";
      },
    });
}

// --- health --------------------------------------------------------

async function checkHealth() {
  try {
    const r = await fetch("/api/health");
    const data = await r.json();
    const dot = $("#health-dot");
    const txt = $("#health-text");
    if (data.tardygrada_daemon === "up") {
      dot.classList.add("up"); dot.classList.remove("down");
      txt.textContent = `daemon up · ${data.registry_size} wrappers`;
    } else {
      dot.classList.add("down");
      txt.textContent = "daemon down — start tardygrada first";
    }
  } catch {
    $("#health-text").textContent = "health check failed";
  }
}

// --- bind ----------------------------------------------------------

$("#plan-btn").addEventListener("click", runPlan);
$("#wrap-btn").addEventListener("click", () => runWrap(selectedTarget));
$("#wrap-url-btn").addEventListener("click", runWrapURL);
$("#rerun-btn").addEventListener("click", () => {
  // Re-run whichever tab is active
  const activeTab = $(".tab.active").dataset.tab;
  if (activeTab === "builtin") runWrap(selectedTarget);
  else runWrapURL();
});

loadRegistry();
checkHealth();
setInterval(checkHealth, 8000);
