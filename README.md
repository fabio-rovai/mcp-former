# mcp-former

[![Sponsor](https://img.shields.io/github/sponsors/fabio-rovai?label=Sponsor&logo=GitHub%20Sponsors&logoColor=EA4AAA&color=EA4AAA)](https://github.com/sponsors/fabio-rovai)

**Terraform for legacy software → AI agents.**

mcp-former wraps existing software (CLIs, APIs, libraries) behind a
verification gate, so an LLM can drive it without footguns. Every call
goes through `decompose → ground → verify` against a domain ontology
before it touches the underlying system.

The pitch: you have legacy software (a Rails monolith, a vendor CLI,
an OpenAPI service, a Cobol RPC endpoint) that you want an LLM agent
to drive. Today the LLM hallucinates calls — `delete user 42` when 42
doesn't exist; `migrate --reset` because it pattern-matched a similar
example. mcp-former wraps that software so each tool call is grounded
against the system's actual domain model before it runs.

## Status

v0 prototype. One concrete adapter (`git`), one introspector (Mode A,
heuristic). Architecture is real; surface area is small.

## How it works

```
LLM
 │
 ▼  (MCP tool call, e.g. "delete branch main")
mcpf-<adapter>            adapter scripts in bin/
 │
 ├─► build a CLAIM about the operation's safety
 │      e.g. "main is a protected_branch"
 ├─► tardygrada daemon (verification engine)
 │      └─► VERIFIED  → operation is unsafe, REJECT
 │      └─► ontology_gap → no rule against it, EXECUTE
 ▼
underlying software        (only if gate passes)
```

Two halves:

1. **Introspection (`mcpf plan`)** reads the target software's surface
   area (`--help`, OpenAPI specs, RPC schemas) and emits an ontology
   (`ontologies/<target>.nt`) describing what's read-only, mutating,
   destructive. Mirrors `terraform plan`: outputs a diff against the
   existing ontology, applies on confirmation.

2. **Adapters (`mcpf-<target>`)** wrap each piece of software's CLI
   (or API) and route every operation through the verification gate.
   Read-only ops pass through; destructive ops grounded against the
   ontology get rejected unless `--allow-unsafe` is passed.

The verification engine is **tardygrada**, a separate project. It
runs as a daemon at `/tmp/tardygrada.sock` and exposes the
`submit-fact`, `run`, `verify-claim` MCP tools. mcp-former talks to
it; it doesn't fork or vendor it.

## Install (dev)

```sh
# 1. Install tardygrada (the verification engine)
git clone https://github.com/fabio-rovai/tardygrada
cd tardygrada && make
./tardygrada daemon start

# 2. Clone mcp-former
git clone https://github.com/fabio-rovai/mcp-former  # not yet pushed
cd mcp-former
export PATH="$PWD/bin:$PATH"

# 3. Test
mcpf plan git
mcpf git status
```

## Demos

### `mcpf plan git`

Discover git's surface area, classify each subcommand:

```
$ mcpf plan git
[1/4] discovering surface area ........ 164 subcommands found
[2/4] classifying ..................... 29 read-only / 121 mutating / 14 destructive
[3/4] generating frames ............... 14 destructive_op facts
[4/4] diff vs ontologies/git.nt
  + add    filter_branch is_a destructive_op
  + add    rm is_a destructive_op
  + add    reflog is_a destructive_op
  ...
Plan: 14 to add, 0 to modify, 5 to remove.
Run with --apply to commit.
```

`--apply` writes the new facts to `ontologies/git.nt`.
`--reload-daemon` also pushes them to the running tardygrada daemon's
LEARNED tier so they take effect without a restart.

### `mcpf git`

Run git through the gate:

```
$ mcpf git status              # passthrough — not gated
$ mcpf git branch -D feature-x # ungrounded — executes
$ mcpf git branch -D main      # grounded as protected_branch — REJECTED

REJECTED by mcp-former: main is a protected_branch
  grounded: main is_a protected_branch  (tier=bundled)
  override with --allow-unsafe if you really mean it
```

`--explain` prints the verification trace.
`--allow-unsafe` overrides the gate.

## Bundled adapters

| Adapter | Status | Coverage |
|---|---|---|
| `git` | demo | 5 gated subcommands, 11-fact ontology |

**Coming next:** `kubectl`, `psql`, `aws`, `gh`. Each is its own
`mcpf-<name>` script that wraps the underlying CLI, plus an
`ontologies/<name>.nt` describing its protection model.

## Repository layout

```
mcp-former/
├── bin/
│   ├── mcpf              top-level dispatcher
│   ├── mcpf-plan         introspector (Mode A heuristic)
│   └── mcpf-git          first concrete adapter
├── ontologies/
│   └── git.nt            git's protection model
├── examples/             demo scripts (TBD)
├── tests/                regression tests (TBD)
├── README.md             this file
└── ARCHITECTURE.md       deeper design notes (TBD)
```

## The model gap (known)

`mcpf plan git` produces per-subcommand facts (`push is_a
destructive_op`). The hand-curated `ontologies/git.nt` uses
per-operation facts (`push_force is_a destructive_op`) because the
wrapper checks `push --force` specifically. Both granularities are
valid:

- **Per-subcommand** (auto-discovered): "this CLI command exists and
  has a destructive mode somewhere"
- **Per-operation** (hand-curated): "this exact flag combination is
  destructive"

For v0, both coexist; the adapter queries the per-operation name and
relies on the ontology containing it. Future work: have `mcpf plan`
emit per-flag facts by parsing each subcommand's full help.

## Why this is the moat

The verification engine (tardygrada) is replicable. The introspection
heuristics are replicable. What isn't:

1. **The wrapper format itself** — frames + ontology + verification
   semantics. Once a critical mass of wrappers exists in this format,
   alternatives must be backwards-compatible or fail. (Same dynamic
   that won Terraform: not the binary, the *Registry*.)

2. **The accumulated wrapper library** — pre-terraformed software
   (git, kubectl, postgres, Stripe, Shopify, SAP, Salesforce, custom
   enterprise systems). Each new wrapper compounds value.

3. **Provenance / validation infrastructure** — `bundled / sovereign
   / learned` tiers, K-of-N validation, rejection memory. The trust
   layer that makes community contribution viable.

The strongest target is **cross-vendor neutral / long-tail enterprise
software** (postgres, SAP, mainframes, Oracle Forms, custom internal
CRMs). AWS won't ship verified MCP wrappers for Azure services and
vice versa — there's room for a Switzerland.

## Roadmap

**v0.1 — current.** git adapter, heuristic introspector, README.

**v0.2 — LLM-assisted classification.** Use the Anthropic API to
classify subcommands when `ANTHROPIC_API_KEY` is set. Catches the
nuance the keyword heuristic misses (e.g. `tag` is mostly mutating,
not destructive, despite the word "delete" in its description).

**v0.3 — second adapter.** `mcpf-kubectl` or `mcpf-psql`. Tests
whether the pattern generalizes or git was easy because of strong CLI
conventions.

**v0.4 — MCP-server wrapper.** Each adapter exposes itself as an MCP
server, not just a CLI, so an LLM in Claude Code or Cursor can call
it directly.

**v0.5 — auto-introspection from OpenAPI / Swagger.** Take a Swagger
spec, emit a complete ontology + adapter without any hand-curation.

**v1.0 — Mode B (blackbox reverse engineering).** Behavioral probing
+ LLM-as-oracle for closed-source legacy systems. The hard problem.

## License

TBD (likely Apache 2.0).

## Related

- [tardygrada](https://github.com/fabio-rovai/tardygrada) — the
  verification engine mcp-former depends on.
- [open-ontologies](https://github.com/fabio-rovai/open-ontologies) —
  ontology research.

---

## Sponsor

If this work is useful to you, you can support its continued development through [GitHub Sponsors](https://github.com/sponsors/fabio-rovai).
