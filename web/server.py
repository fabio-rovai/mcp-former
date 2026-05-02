#!/usr/bin/env python3
"""
mcp-former web app — paste a CLI tool name (or eventually a GitHub URL),
get back a verifiable wrapper.

Backend: FastAPI. Streams `mcpf plan` output via Server-Sent Events so
the user sees discovery / classification / diff happening live.

Endpoints:

    GET  /                  landing page
    GET  /static/*          static assets
    POST /api/introspect    {target: "git" | "kubectl" | "gh" | ...}
                            streams mcpf-plan output as SSE
    GET  /api/registry      list of available bundled wrappers
    GET  /api/download/<t>  download wrapper bundle (ontology + adapter)

Run:
    pip install fastapi uvicorn
    python web/server.py
    open http://localhost:8765

Run with hot reload during dev:
    uvicorn web.server:app --reload --port 8765
"""
import asyncio
import io
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

try:
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.responses import (
        FileResponse, HTMLResponse, JSONResponse, StreamingResponse)
    from fastapi.staticfiles import StaticFiles
except ImportError:
    print("fastapi not installed. Run: pip install fastapi uvicorn",
          file=sys.stderr)
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "bin"
ONTOLOGIES = ROOT / "ontologies"
STATIC = Path(__file__).resolve().parent / "static"

# Bundled wrappers — extended whenever we add a new mcpf-* adapter.
REGISTRY = [
    {
        "target": "git",
        "name": "git",
        "description": "Distributed version control",
        "adapter": "mcpf-git",
        "ontology": "git.nt",
        "gated_subcommands": ["branch -D", "push --force", "reset --hard",
                              "clean -f", "checkout --"],
    },
    {
        "target": "kubectl",
        "name": "kubectl",
        "description": "Kubernetes cluster CLI",
        "adapter": "mcpf-kubectl",
        "ontology": "kubectl.nt",
        "gated_subcommands": ["delete", "drain", "cordon",
                              "apply --force", "replace --force"],
    },
    {
        "target": "gh",
        "name": "gh",
        "description": "GitHub CLI",
        "adapter": "mcpf-gh",
        "ontology": "gh.nt",
        "gated_subcommands": ["repo delete", "release delete",
                              "workflow disable", "secret delete"],
    },
    {
        "target": "aws",
        "name": "aws",
        "description": "AWS CLI",
        "adapter": "mcpf-aws",
        "ontology": "aws.nt",
        "gated_subcommands": ["ec2 terminate-instances",
                              "s3 rb --force", "s3 rm --recursive",
                              "rds delete-db-instance",
                              "iam delete-*",
                              "cloudformation delete-stack"],
    },
    {
        "target": "psql",
        "name": "psql",
        "description": "PostgreSQL CLI (gates SQL statements)",
        "adapter": "mcpf-psql",
        "ontology": "psql.nt",
        "gated_subcommands": ["DROP TABLE", "DROP DATABASE", "TRUNCATE",
                              "DELETE without WHERE", "GRANT on superuser"],
    },
]


app = FastAPI(title="mcp-former")
app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    return (STATIC / "index.html").read_text()


@app.get("/api/registry")
async def registry():
    """Return bundled wrapper list, filtered to those whose adapter
    actually exists in bin/."""
    available = []
    for entry in REGISTRY:
        adapter_path = BIN / entry["adapter"]
        ontology_path = ONTOLOGIES / entry["ontology"]
        out = dict(entry)
        out["adapter_present"] = adapter_path.exists()
        out["ontology_present"] = ontology_path.exists()
        out["status"] = ("ready" if (adapter_path.exists() and
                                      ontology_path.exists())
                          else "stub")
        available.append(out)
    return {"wrappers": available}


def sse(event, data):
    """Format a Server-Sent Events frame."""
    payload = json.dumps(data) if not isinstance(data, str) else data
    return f"event: {event}\ndata: {payload}\n\n"


async def stream_plan(target: str, use_llm: bool):
    """Run `mcpf plan <target>` as a subprocess, stream stdout line by
    line as SSE events. End with a 'done' event carrying the final
    artifact bundle."""
    plan_bin = BIN / "mcpf-plan"
    if not plan_bin.exists():
        yield sse("error", {"message": f"adapter binary missing: {plan_bin}"})
        return

    env = os.environ.copy()
    cmd = [str(plan_bin), target]
    if use_llm:
        cmd.append("--llm")
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, env=env)
    yield sse("start", {"target": target, "cmd": " ".join(cmd)})
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        yield sse("log", {"line": line.decode("utf-8", "replace").rstrip()})
    rc = await proc.wait()
    yield sse("done", {"target": target, "exit_code": rc})


@app.post("/api/introspect")
async def introspect(req: Request):
    body = await req.json()
    target = body.get("target", "").strip()
    use_llm = bool(body.get("use_llm", False))
    if not target:
        raise HTTPException(status_code=400, detail="missing target")
    if target not in (entry["target"] for entry in REGISTRY):
        raise HTTPException(
            status_code=400,
            detail=f"unknown target '{target}' "
                   f"(known: {[e['target'] for e in REGISTRY]})")

    return StreamingResponse(
        stream_plan(target, use_llm),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache",
                 "X-Accel-Buffering": "no"})


async def stream_wrap(target_or_url: str, use_llm: bool = False):
    """Run `mcpf wrap <target>` as a subprocess in a temp dir, stream
    progress, then end with a 'bundle_ready' event carrying a path the
    caller can hit /api/download-bundle/<id> on."""
    import tempfile
    work = tempfile.mkdtemp(prefix="mcpf-wrap-")
    out_dir = os.path.join(work, "bundle")
    wrap_bin = BIN / "mcpf-wrap"
    if not wrap_bin.exists():
        yield sse("error", {"message": f"adapter binary missing: {wrap_bin}"})
        return
    cmd = [str(wrap_bin), target_or_url, "--out", out_dir, "--zip"]
    if use_llm:
        cmd.append("--llm")
    yield sse("start", {"target": target_or_url, "cmd": " ".join(cmd)})
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT)
    while True:
        line = await proc.stdout.readline()
        if not line:
            break
        yield sse("log", {"line": line.decode("utf-8", "replace").rstrip()})
    rc = await proc.wait()
    if rc == 0:
        # Path is out_dir.zip per mcpf-wrap convention
        zip_path = out_dir + ".zip"
        if os.path.exists(zip_path):
            # Stash the path under a short token so the client can download
            token = os.path.basename(work)
            BUNDLE_CACHE[token] = zip_path
            yield sse("bundle_ready",
                      {"token": token,
                       "filename": f"mcp-former-{re.sub(r'[^A-Za-z0-9]+', '-', target_or_url)}.zip"})
    yield sse("done", {"target": target_or_url, "exit_code": rc})


# In-memory cache: token → bundle zip path. Lives for the process
# lifetime; bundles in /tmp get garbage-collected by the OS.
BUNDLE_CACHE = {}


@app.post("/api/wrap")
async def wrap_target(req: Request):
    body = await req.json()
    target = body.get("target", "").strip()
    use_llm = bool(body.get("use_llm", False))
    if not target:
        raise HTTPException(status_code=400, detail="missing target")
    return StreamingResponse(
        stream_wrap(target, use_llm=use_llm),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache",
                 "X-Accel-Buffering": "no"})


@app.get("/api/download-bundle/{token}")
async def download_bundle(token: str):
    path = BUNDLE_CACHE.get(token)
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="bundle expired or missing")
    return FileResponse(path, media_type="application/zip",
                         filename=os.path.basename(path))


@app.get("/api/download/{target}")
async def download(target: str):
    """Bundle the adapter script + ontology into a zip and return."""
    entry = next((e for e in REGISTRY if e["target"] == target), None)
    if not entry:
        raise HTTPException(status_code=404, detail="unknown target")

    adapter_path = BIN / entry["adapter"]
    ontology_path = ONTOLOGIES / entry["ontology"]
    if not (adapter_path.exists() and ontology_path.exists()):
        raise HTTPException(status_code=404,
                             detail="wrapper not yet built")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.write(adapter_path,
                  arcname=f"mcp-former-{target}/bin/{entry['adapter']}")
        zf.write(ontology_path,
                  arcname=f"mcp-former-{target}/ontologies/{entry['ontology']}")
        readme = f"""# mcp-former: {entry['name']}

{entry['description']}

Generated by mcp-former. Drop-in wrapper that gates {entry['name']}'s
destructive operations against a domain ontology.

## Setup

1. Install tardygrada (the verification engine):
   https://github.com/fabio-rovai/tardygrada

2. Make the adapter executable and put it on PATH:
   chmod +x bin/{entry['adapter']}
   export PATH=$PWD/bin:$PATH

3. Inject the ontology into the running tardygrada daemon, OR copy
   ontologies/{entry['ontology']} to tardygrada's tests/ directory and
   restart the daemon.

## Gated operations
""" + "\n".join(f"- {sc}" for sc in entry["gated_subcommands"]) + """

## Use
""" + f"\n    {entry['adapter']} <args>\n    {entry['adapter']} --explain <args>\n    {entry['adapter']} --allow-unsafe <args>\n"
        zf.writestr(f"mcp-former-{target}/README.md", readme)

    buf.seek(0)
    return StreamingResponse(
        iter([buf.read()]),
        media_type="application/zip",
        headers={"Content-Disposition":
                 f"attachment; filename=mcp-former-{target}.zip"})


@app.get("/api/health")
async def health():
    """Daemon connectivity + binary presence check."""
    socket_present = os.path.exists("/tmp/tardygrada.sock")
    plan_bin = BIN / "mcpf-plan"
    return {
        "tardygrada_daemon": "up" if socket_present else "down",
        "mcpf_plan": plan_bin.exists(),
        "registry_size": len(REGISTRY),
    }


if __name__ == "__main__":
    try:
        import uvicorn
    except ImportError:
        print("uvicorn not installed. Run: pip install fastapi uvicorn",
              file=sys.stderr)
        sys.exit(1)
    port = int(os.environ.get("MCPF_WEB_PORT", "8766"))
    print(f"mcp-former web → http://localhost:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
