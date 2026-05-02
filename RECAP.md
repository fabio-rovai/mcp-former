# mcp-former — recap

**One sentence:** download a repo, map what everything does as a graph, rebuild it as MCP.

That's the whole product. This doc is what's been built across v0.1 → v0.13 and why each piece exists.

## The thesis

LLMs are getting good at driving software. They're also good at hallucinating the destructive calls — `delete user 42` when 42 doesn't exist, `migrate --reset` because it pattern-matched a similar example, `helm uninstall production` because the prompt was ambiguous. Today there's no general way to put a safety gate between an LLM and an arbitrary CLI/API.

mcp-former generates that gate, automatically, from any GitHub repo.

## The pipeline

```
GitHub URL                                       (1) download
    │
    ▼
git clone --depth=1
    │
    ▼
detect binary  ──→  Cargo.toml / pyproject / package.json / go.mod
    │
    ▼
read README + `binary --help`                    (2) map as a graph
    │
    ▼
LLM (claude-haiku-4-5)
    │  via Anthropic API or local `claude -p` (your Claude Code session)
    │  ┌──────────────────────────────────┐
    │  │ T-Box: Resource, Operation,      │
    │  │   ProtectedThing, DestructiveOp  │
    │  │ A-Box: <main> a Branch,          │
    │  │        a ProtectedBranch         │
    │  └──────────────────────────────────┘
    ▼
OWL-RL reasoner (rdflib + owlrl)
    │  closes subclass hierarchy:
    │    Branch → Ref → GitObject → Resource
    │    ProtectedBranch → ProtectedRef → ProtectedThing
    ▼
open-ontologies validate    ←  third-party validator
    │  (rejects malformed Turtle, lints predicates)
    ▼
flat is_a triples           (ontologies/<tool>.nt)
    │
    ▼
mcpf audit                                      (3) rebuild as MCP
    │  pytest-style conformance:
    │    sanity / existence / coverage / grounding
    │  (failures don't block the build, but ship in AUDIT.md)
    ▼
bundle assembly:
  bin/mcpf-<tool>     ←  generic ontology-driven adapter
  ontologies/<tool>.nt ← the gate's protection model
  mcp_server.py        ← JSON-RPC over stdio (MCP standard)
  skill.md             ← Anthropic skill description
  README.md            ← setup instructions
  AUDIT.md             ← conformance report
    │
    ▼
mcpf install <tool>
    │  copies bundle to ./wrappers/<tool>/
    │  auto-loads ontology into the running tardygrada daemon
    ▼
~/.claude/mcp.json registers mcp_server.py
    │
    ▼
LLM calls the wrapped tool through the gate
    └─→ every call goes claim → ground → verify
        before it touches the underlying CLI
```

## Component tree

```
mcp-former/                              private repo, github.com/fabio-rovai/mcp-former
├── bin/                                 the CLI surface
│   ├── mcpf                             top-level dispatcher (subcommands below)
│   ├── mcpf-wrap          v0.5–v0.13   download + LLM + materialise + bundle + audit
│   ├── mcpf-plan           v0.1–v0.4   Mode A heuristic introspector (kept for built-ins)
│   ├── mcpf-materialize    v0.10       OWL-RL closure: schema.ttl + tool.ttl → tool.nt
│   ├── mcpf-audit          v0.12       conformance test (sanity/existence/coverage/grounding)
│   ├── mcpf-registry       v0.7        list / install / show / reload / --no-load
│   └── mcpf-{git,kubectl,gh,aws,psql}   precomputed adapters (scaffolding for the format)
│
├── ontologies/                          the protection models
│   ├── schema.ttl          v0.10–v0.11  shared T-Box: Resource, Operation, ProtectedThing
│   │                                     + per-tool subhierarchies
│   ├── git.ttl             v0.10        Branch ⊂ Ref ⊂ GitObject; main a Branch, ProtectedBranch
│   ├── kubectl.ttl         v0.10        Pod, Deployment, Namespace, Node, Cluster
│   ├── aws.ttl             v0.10        Ec2Instance, S3Bucket, RdsInstance, …
│   ├── gh.ttl              v0.10        Repo, Release, Issue, Secret
│   ├── psql.ttl            v0.10        Database, DbSchema, Table, Role
│   └── *.nt                              materialised flat triples (loaded by tardygrada)
│
├── templates/                           bundle output templates
│   ├── mcp_server.py.tmpl  v0.5         JSON-RPC over stdio, exposes <tool>_run + describe_gate
│   └── skill.md.tmpl       v0.5         Anthropic skill format with override etiquette
│
├── registry/
│   └── index.json          v0.7         5 wrappers with categories, versions, fact counts
│
├── web/                                 FastAPI app on :8766
│   ├── server.py           v0.4–v0.8   /api/registry, /api/wrap, /api/download-bundle, …
│   └── static/                          single-input UI, live SSE streaming, Registry tab
│
├── demo/
│   └── universal-benchmark.sh v0.12     end-to-end demo on any URL
│
├── README.md
├── ARCHITECTURE.md
├── RECAP.md                              this file
└── .gitignore
```

## What each layer owns

| Layer | Owns | Doesn't own |
|---|---|---|
| **mcp-former** | introspection UX, wrapper format, ontology materialisation, audit, registry, MCP server template, skill template | verification engine, BFT pipeline, daemon, ontology storage |
| **tardygrada** | C daemon, BFT 3-pass, ontology storage, frame registry, `submit-fact` MCP tool, the trust gradient (bundled / sovereign / learned) | introspection, wrapper templates, MCP server scaffolding |
| **open-ontologies** | validating Turtle/OWL syntax, terraform-style plan, OWL-DL reasoning (we use it for `validate`; could also use for `reason`), ontology marketplace | anything specific to wrapping CLIs |

mcp-former depends on the other two at runtime — no fork, no vendoring. Tardygrada and open-ontologies don't know mcp-former exists.

## Version timeline

| Version | What shipped | Why it mattered |
|---|---|---|
| v0.1 | initial prototype, mcpf-git adapter, git_ontology.nt | proves the wrapper format on one tool |
| v0.2 | LLM-assisted classification (Anthropic API) | replaces brittle keyword heuristics |
| v0.3 | mcpf-kubectl + bundled fixture | tests generality beyond git |
| v0.4 | web app, mcpf-gh / mcpf-aws / mcpf-psql | five built-in adapters; psql gates SQL not flags |
| v0.5 | **mcpf wrap** — emits MCP server + skill bundle | the artifact upgrades from "adapter zip" to "drop-in MCP server" |
| v0.6 | LLM-assisted ontology generation, validated through open-ontologies | URL bundles get real protection rules, not stubs |
| v0.7 | registry — list / install / show + web tab | foundational moat piece, versioned catalog |
| v0.8 | claude-cli backend, single-input UI, mandatory ontology | no API key needed, simpler UX, no empty stubs |
| v0.9 | mcpf install auto-loads ontology into daemon | removes manual python one-liner |
| v0.10 | real OWL ontology — T-Box + A-Box + OWL-RL closure | flat fact lists become a proper class hierarchy |
| v0.11 | domain layer — Resource hierarchy + targetClass | ontology decomposes the software, not just lists protections |
| v0.12 | universal converter — generic gate + mcpf audit + benchmark | per-tool adapters become scaffolding; the URL flow is the product |
| v0.13 | wrap auto-audits, AUDIT.md in every bundle | conformance report ships with the wrapper |

## What's defensible (the moat)

The verification engine is replicable. The introspection heuristic is replicable. The wrapper format and the accumulated wrapper library are not.

1. **The wrapper format itself.** Frames + ontology + verification semantics. Once a critical mass of wrappers exists in this format, alternatives have to be backwards-compatible or fail. Same dynamic that won Terraform: not the binary, the *Registry*.
2. **The accumulated wrapper library.** Each new wrapped tool compounds value. git, kubectl, gh, aws, psql, rclone, terraform, helm, syncthing, … and eventually the long-tail enterprise software (SAP, Oracle Forms, Workday, custom internal CRMs) that no cloud has incentive to wrap.
3. **Provenance / validation infrastructure.** `bundled / sovereign / learned` tiers, K-of-N validation, rejection memory — the trust layer that makes a community contribution model viable without trusting random wrappers blindly.

## What's still missing

- **Real-time wrap-on-PR.** `mcp wrap` runs at human invocation today. A GitHub App that wraps every push and posts a wrapper-update PR comment is the SaaS surface.
- **Per-flag classification.** The LLM emits flag-level facts (`push_force`) but the audit's coverage check looks for subcommand-level (`push`). Both are valid; the audit could be smarter about reconciling them.
- **Standard ontology imports.** Open-ontologies ships 32 standard ontologies (FOAF, SKOS, schema.org, BFO, FIBO). Nothing in mcp-former pulls from them yet. A psql wrapper could import FIBO's database concepts; an aws wrapper could import schema.org's compute concepts.
- **Public deploy.** Web app runs on localhost only. Putting it on Fly.io / Railway behind a real URL is the first step toward letting non-local users try it.
- **Mode B (blackbox introspection).** Today we read `--help` and README. Closed-source legacy systems need behavioural probing + LLM-as-oracle. Real research problem; v3+ work.

## Three numbers from the benchmark (v0.12)

| Project | Wrap | Facts | LLM verdict |
|---|---|---|---|
| `rclone` | 24s | 20 | data-mover, 14 destructive verbs + 4 destructive flags |
| `glow` | 11s | 0 | read-only file viewer, no destructive ops needed (correct) |
| `terraform` | 29s | 35 | `destroy`, `apply --auto-approve`, `taint`, plus 32 more |

Quality scales with README richness, not repo size. Read-only tools correctly come back as zero-fact. Wrap time is bounded by the LLM call (~10–30s).
