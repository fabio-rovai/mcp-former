// mcp-former — single-page client.
// One input field, auto-detects whether it's a built-in target name
// or a GitHub URL.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let registryNames = new Set();   // populated from /api/registry

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

// --- tabs -----------------------------------------------------------

$$(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    $$(".tab").forEach((x) => x.classList.toggle(
      "active", x.dataset.tab === t.dataset.tab));
    $$(".tab-panel").forEach((p) => p.classList.toggle(
      "hidden", p.id !== `tab-${t.dataset.tab}`));
    if (t.dataset.tab === "registry") loadRegistryFull();
  });
});

// --- target detection -----------------------------------------------

function detectTargetType(value) {
  const v = value.trim();
  if (!v) return {kind: "empty"};
  if (/^https?:\/\/github\.com\/[^/]+\/[^/]+/.test(v)) {
    return {kind: "url", value: v};
  }
  // Allow shorthand: github.com/owner/repo
  if (/^github\.com\/[^/]+\/[^/]+/.test(v)) {
    return {kind: "url", value: "https://" + v};
  }
  if (registryNames.has(v)) {
    return {kind: "builtin", value: v};
  }
  // Could be a built-in we don't know about, or a typo
  return {kind: "unknown", value: v};
}

function updateDetected() {
  const v = $("#target-input").value;
  const det = detectTargetType(v);
  const out = $("#target-detected");
  const btn = $("#generate-btn");
  switch (det.kind) {
    case "empty":
      out.innerHTML = "&nbsp;";
      btn.disabled = true;
      break;
    case "url":
      out.innerHTML =
        `<span class="ansi-cyan">⤷</span> ` +
        `<span class="ansi-dim">GitHub URL — will clone, detect ` +
        `binary, generate ontology via LLM</span>`;
      btn.disabled = false;
      break;
    case "builtin":
      out.innerHTML =
        `<span class="ansi-green">✓</span> ` +
        `<span class="ansi-dim">built-in target — uses curated ` +
        `ontology</span>`;
      btn.disabled = false;
      break;
    case "unknown":
      out.innerHTML =
        `<span class="ansi-yellow">?</span> ` +
        `<span class="ansi-dim">unknown name — must be a built-in ` +
        `(${[...registryNames].join(", ")}) or a GitHub URL</span>`;
      btn.disabled = true;
      break;
  }
}

// --- registry data --------------------------------------------------

async function loadRegistry() {
  const r = await fetch("/api/registry");
  const data = await r.json();
  registryNames = new Set(
    data.wrappers
      .filter((w) => w.status === "ready")
      .map((w) => w.target));
  // Prime the input to refresh detection state if user already typed
  updateDetected();
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
      .map((c) => `<span class="reg-cat">${escapeHtml(c)}</span>`).join("");
    const gates = (w.gated_subcommands || [])
      .map((g) => `<li>${escapeHtml(g)}</li>`).join("");
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
    card.querySelector(".reg-name").style.cursor = "pointer";
    card.querySelector(".reg-name").addEventListener("click", () => {
      // Quick "Send to Generate" — populates the input + switches tab
      $("#target-input").value = w.name;
      updateDetected();
      $$(".tab")[0].click();
      $("#target-input").focus();
    });
    wrap.appendChild(card);
  }
  registryFullLoaded = true;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- streaming output ----------------------------------------------

function showOutput() {
  $("#output-card").classList.remove("hidden");
  $("#output-actions").classList.add("hidden");
  $("#output").innerHTML = "";
  $("#output-status").textContent = "running…";
  $("#output-status").className = "status running";
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

// --- main flow -----------------------------------------------------

async function runGenerate() {
  const det = detectTargetType($("#target-input").value);
  if (det.kind === "empty" || det.kind === "unknown") return;

  const backend =
    document.querySelector('input[name="llm-backend"]:checked').value;

  $("#generate-btn").disabled = true;
  $("#hint-gen").textContent = "running…";
  showOutput();

  await streamSSE("/api/wrap",
    {target: det.value, llm_backend: backend},
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
        $("#generate-btn").disabled = false;
        $("#hint-gen").textContent =
          ok ? "bundle generated" :
               "failed — check the output above";
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

$("#target-input").addEventListener("input", updateDetected);
$("#target-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !$("#generate-btn").disabled) runGenerate();
});
$("#generate-btn").addEventListener("click", runGenerate);
$("#rerun-btn").addEventListener("click", runGenerate);

loadRegistry();
checkHealth();
setInterval(checkHealth, 8000);
