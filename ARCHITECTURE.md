# mcp-former architecture

## Goal

Make any piece of legacy software safely callable by an LLM agent
without hand-coding the safety rules. The system should:

1. **Discover** the surface area of the target (CLI, API, library)
2. **Classify** each operation by destructiveness (read-only /
   mutating / destructive)
3. **Verify** every call before it executes against a domain ontology
4. **Trace** rejections back to a specific grounded fact (provenance)

## The two-layer model

```
┌─────────────────────────────────────┐
│  mcp-former  (this repo)            │
│                                     │
│  ┌──────────────┐  ┌─────────────┐  │
│  │  introspect  │  │  adapters   │  │
│  │  mcpf plan   │  │  mcpf-git,  │  │
│  │              │  │  mcpf-kubectl │
│  └──────┬───────┘  └──────┬──────┘  │
│         │                 │         │
│         ▼                 ▼         │
│  ontologies/*.nt   verification     │
│         │                 │         │
└─────────┼─────────────────┼─────────┘
          │                 │
          ▼                 ▼
┌─────────────────────────────────────┐
│  tardygrada  (separate repo)        │
│                                     │
│  daemon → ontology → BFT verify     │
│  - submit-fact (write)              │
│  - run (verify a claim)             │
│  - tier provenance                  │
│  - validation gate (K-of-N)         │
└─────────────────────────────────────┘
```

Each layer has a single responsibility:

| Layer | Owns |
|---|---|
| **mcp-former** | introspection UX, wrapper format, adapter library, registry |
| **tardygrada** | verification engine, ontology storage, BFT pipeline |

mcp-former depends on tardygrada at runtime. There is no fork, no
vendoring; mcp-former talks to the tardygrada daemon via the documented
socket / MCP protocol.

## Trust gradient (inherited from tardygrada)

Every fact in the ontology has a tier:

- **bundled**   — hand-curated, ships in `ontologies/<target>.nt`
- **sovereign** — promoted after K_PROMOTE re-confirmations by
                  validators
- **learned**   — freshly accepted via `submit-fact`, not yet
                  re-confirmed

When a verification rejects a call, the rejection includes the tier
of the supporting fact. This gives a clear answer to "why did this
get blocked?" — the user sees not just *that* it was blocked but
*which* fact, and how trustworthy that fact is.

## Two granularities of destructiveness

mcp-former operates at two granularities simultaneously:

### Per-subcommand (auto-discovered)

`mcpf plan` produces facts like:

```
push is_a destructive_op
branch is_a destructive_op
clean is_a destructive_op
```

Coarse-grained: "this command exists and has a destructive mode
somewhere." The classifier is conservative — when in doubt, mark
destructive.

### Per-operation (hand-curated)

`ontologies/<target>.nt` typically contains:

```
push_force is_a destructive_op
branch_delete is_a destructive_op
clean_force is_a destructive_op
```

Fine-grained: "this specific flag combination is destructive." The
adapter (`mcpf-git`) knows which flag → which operation name, and
queries the precise name.

Both coexist; the adapter queries the per-operation name. Future
work: `mcpf plan` learns to emit per-flag facts by parsing each
subcommand's full help.

## Why two granularities?

A blanket `push is destructive` rule would block every push, including
non-force pushes. The flag-level granularity (`push_force`) is what
the adapter actually needs. But the auto-discovery can't *know* about
flags without parsing each subcommand's full help — that's a phase 2
problem (LLM-assisted classification).

For v0:

- `mcpf plan` produces a coarse plan (subcommand-level)
- The user reviews, decides what's noise
- Hand-curated facts in `ontologies/<target>.nt` set the actual gate

This isn't fully automated yet. v0.2's LLM-assisted classification
will narrow the gap.

## Verification flow (concrete)

When you run `mcpf git branch -D main`:

1. `mcpf-git` parses argv, identifies it as a `branch` subcommand
   with `-D` and target `main`.
2. The `gate_branch` function builds a claim: `"main is a
   protected_branch"`.
3. The claim is sent to tardygrada's daemon socket: `{"cmd": "run",
   "claim": "main is a protected_branch"}`.
4. tardygrada's BFT 3-pass:
   - Decompose `"main is a protected_branch"` into a triple
     `(main, is_a, protected_branch)`.
   - Ground against the ontology: `main is_a protected_branch` is
     present in `ontologies/git.nt` (loaded at daemon startup), tier
     `bundled`.
   - Three independent passes confirm `VERIFIED`.
5. Response: `{"result": "VERIFIED", "triples": [{"s": "main", "p":
   "is_a", "o": "protected_branch", "tier": "bundled", ...}]}`.
6. `mcpf-git` sees `result=VERIFIED` AND a grounded triple → reject.
7. User sees:
   ```
   REJECTED by mcp-former: main is a protected_branch
     grounded: main is_a protected_branch (tier=bundled)
   ```

When the call is `mcpf git branch -D feature-x`:

- Same flow, but step 5 returns `result=ontology_gap` (no fact about
  `feature-x is_a protected_branch`).
- `mcpf-git` sees no grounded triple → execute the underlying git
  command.

## What this enables

1. **Data-driven protection.** Adding a new protected branch is a
   one-line edit in `ontologies/git.nt`, or a runtime
   `submit-fact` call. No code change in `mcpf-git`.

2. **Explainable rejection.** Every block traces to a specific fact
   with a tier — auditable, not a hardcoded check buried in code.

3. **Composable wrappers.** `mcpf-kubectl` and `mcpf-psql` share the
   same verification substrate. Adding a new tool means writing one
   adapter + one ontology, not a parallel verification engine.

4. **Community contribution.** Wrappers can be shared and validated
   like Terraform modules. The `bundled / sovereign / learned`
   provenance tiers + the K-of-N validator gate make a contribution
   model viable without trusting random wrappers blindly.

## What's not yet built

- **MCP server interface.** Adapters are CLIs today. To be LLM-callable
  inside Claude Code / Cursor, each needs to be wrapped as an MCP
  server (~50 lines of glue per adapter).

- **OpenAPI / Swagger introspection.** `mcpf plan` only reads CLI
  `--help` output. OpenAPI specs would give richer typed signatures
  for free.

- **Mode B (blackbox).** Behavioral probing of closed-source systems
  via differential testing + LLM-as-oracle.

- **Registry.** Today wrappers live in this repo. v1 needs a public
  registry with versioning, signing, validation badges.

- **Per-flag classification.** v0 classifies subcommands; v0.2 should
  classify each flag combination (`push --force` vs `push`).
