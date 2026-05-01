// mcp-former — single-page client.
// Loads the registry, lets the user pick a target, streams `mcpf plan`
// output via SSE, exposes a download button when the run completes.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let selectedTarget = null;

// --- ANSI → HTML (only the escape codes mcpf-plan uses) -----------------

const ANSI_MAP = {
  "0;32": "ansi-green",
  "0;31": "ansi-red",
  "1;33": "ansi-yellow",
  "0;36": "ansi-cyan",
  "2":    "ansi-dim",
};

function ansiToHtml(text) {
  // Replace ESC[<code>m...ESC[0m with span. Naive but works for the
  // narrow set mcpf-plan emits.
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
      // basic HTML escape
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

// --- registry + presets ------------------------------------------------

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
  $("#run-btn").disabled = false;
  $("#hint").textContent = `${target} selected — ready to introspect`;
}

// --- introspect run ----------------------------------------------------

async function runIntrospect() {
  if (!selectedTarget) return;
  const useLLM = $("#use-llm").checked;
  $("#run-btn").disabled = true;
  $("#hint").textContent = "running…";
  $("#output-card").classList.remove("hidden");
  $("#output-actions").classList.add("hidden");
  $("#output").innerHTML = "";
  $("#output-status").textContent = "running…";
  $("#output-status").className = "status running";

  // POST → SSE.
  // fetch + manual reader so we can parse SSE frames ourselves
  const resp = await fetch("/api/introspect", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({target: selectedTarget, use_llm: useLLM}),
  });

  if (!resp.ok) {
    appendLine(`<span class="ansi-red">request failed: ${resp.status}</span>`);
    $("#output-status").textContent = "error";
    $("#output-status").className = "status error";
    $("#run-btn").disabled = false;
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
      handleFrame(frame);
    }
  }

  $("#run-btn").disabled = false;
}

function handleFrame(frame) {
  // SSE frame: "event: NAME\ndata: PAYLOAD"
  const lines = frame.split("\n");
  let event = "message";
  let data = "";
  for (const ln of lines) {
    if (ln.startsWith("event:")) event = ln.slice(6).trim();
    else if (ln.startsWith("data:")) data += ln.slice(5).trimStart();
  }
  let payload;
  try { payload = JSON.parse(data); } catch { payload = data; }

  if (event === "start") {
    appendLine(`<span class="ansi-dim">$ ${payload.cmd}</span>`);
  } else if (event === "log") {
    appendLine(ansiToHtml(payload.line));
  } else if (event === "done") {
    const ok = payload.exit_code === 0;
    $("#output-status").textContent = ok ? "done" : "error";
    $("#output-status").className = "status " + (ok ? "done" : "error");
    if (ok) {
      const link = $("#download-link");
      link.href = `/api/download/${payload.target}`;
      $("#output-actions").classList.remove("hidden");
    }
    $("#hint").textContent = `${payload.target} — ${ok ? "done" : "failed"}`;
  } else if (event === "error") {
    appendLine(`<span class="ansi-red">${payload.message || data}</span>`);
    $("#output-status").textContent = "error";
    $("#output-status").className = "status error";
  }
}

function appendLine(html) {
  const out = $("#output");
  out.innerHTML += html + "\n";
  out.scrollTop = out.scrollHeight;
}

// --- health --------------------------------------------------------------

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

// --- bind --------------------------------------------------------------

$("#run-btn").addEventListener("click", runIntrospect);
$("#rerun-btn").addEventListener("click", runIntrospect);

loadRegistry();
checkHealth();
setInterval(checkHealth, 8000);
