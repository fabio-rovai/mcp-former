#!/bin/bash
#
# universal-benchmark.sh — end-to-end demo of mcp-former's URL flow.
#
# Picks a random legacy CLI repo, wraps it as an MCP bundle (no
# precomputed adapter — purely the universal converter), then runs a
# test suite of safe + destructive commands through the gate and
# reports before/after numbers.
#
# Use:
#     ./demo/universal-benchmark.sh                          # default: rclone
#     ./demo/universal-benchmark.sh https://github.com/...   # any GitHub repo
#
# Requires the tardygrada daemon to be running (`tardy daemon start`)
# and the `claude` CLI on PATH for the LLM-driven ontology generation.

set -e
cd "$(dirname "$0")/.."
PATH="$PWD/bin:$PATH"

URL="${1:-https://github.com/rclone/rclone}"
WORK=$(mktemp -d)
NAME=$(basename "$URL" .git)

CYAN="\033[0;36m"
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[1;33m"
DIM="\033[2m"
NC="\033[0m"

step() { echo; echo -e "${CYAN}── $1 ──${NC}"; }
ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
bad()  { echo -e "  ${RED}✗${NC} $1"; }
note() { echo -e "  ${DIM}$1${NC}"; }

# ----------------------------------------------------------------------

step "1. Wrap target ($URL)"
T0=$(python3 -c "import time; print(time.time())")
mcpf wrap --llm-via claude-cli "$URL" --out "$WORK/bundle" 2>&1 | sed 's/^/  /'
T1=$(python3 -c "import time; print(time.time())")
WRAP_TIME=$(python3 -c "print(f'{($T1)-($T0):.1f}')")
note "wrap wall time: ${WRAP_TIME}s"

# ----------------------------------------------------------------------

step "2. Bundle artifacts"
ls -la "$WORK/bundle" | tail -n +2 | sed 's/^/  /'
echo
note "ontology size:"
ONTO=$(ls "$WORK/bundle/ontologies/"*.nt | head -1)
FACTS=$(grep -c "^<" "$ONTO" || true)
note "  $FACTS facts in $(basename $ONTO)"
note "first 8 facts:"
grep "^<" "$ONTO" | head -8 | sed 's|<http://tardygrada.org/||g; s|<http://schema.org/||g; s|>||g' | sed 's/^/    /'

# ----------------------------------------------------------------------

step "3. Load ontology into tardygrada daemon"
python3 - <<PY
import json, socket, re, sys
NT_RE = re.compile(r'^<[^>]*org/(?P<s>[^>]+)>\s+<[^>]*org/(?P<p>[^>]+)>\s+<[^>]*org/(?P<o>[^>]+)>\s*\.\s*$')
def send(p):
    s=socket.socket(socket.AF_UNIX); s.connect("/tmp/tardygrada.sock")
    s.sendall((json.dumps(p)+"\n").encode()); s.shutdown(socket.SHUT_WR)
    o=b""
    while True:
        d=s.recv(4096)
        if not d: break
        o+=d
    return json.loads(o.decode().strip())
counts={"accepted":0,"duplicate":0,"other":0}
for line in open("$ONTO"):
    m=NT_RE.match(line.strip())
    if not m: continue
    r=send({"cmd":"submit-fact","subject":m.group("s"),
            "predicate":m.group("p"),"object":m.group("o")})
    counts[r.get("status","other")]=counts.get(r.get("status","other"),0)+1
print(f"  loaded: {counts['accepted']} new, {counts['duplicate']} duplicate, {counts['other']} other")
PY

# ----------------------------------------------------------------------

step "4. Test suite — gate decisions"
ADAPTER="$WORK/bundle/bin/mcpf-$NAME"
chmod +x "$ADAPTER"

# Test cases — derived from rclone's surface but generic enough that
# many CLIs share these verbs.
DESTRUCTIVE=(
    "delete remote:foo"
    "purge remote:bar"
    "rmdirs remote:baz"
    "cleanup remote:bucket"
    "moveto src: dst:"
)

SAFE=(
    "ls remote:bucket"
    "lsf remote:bucket"
    "size remote:bucket"
    "config dump"
    "version"
    "tree remote:bucket"
)

PASSED_DESTRUCTIVE=0
BLOCKED_DESTRUCTIVE=0
PASSED_SAFE=0
BLOCKED_SAFE=0

LATENCIES=()

run_one() {
    local CMDLINE=$1
    # shellcheck disable=SC2206
    local ARGS=($CMDLINE)
    local START
    START=$(python3 -c "import time; print(time.time())")
    "$ADAPTER" "${ARGS[@]}" > /dev/null 2>&1
    local EC=$?
    local END
    END=$(python3 -c "import time; print(time.time())")
    local LAT
    LAT=$(python3 -c "print(int(($END-$START)*1000))")
    LATENCIES+=("$LAT")
    return $EC
}

note "destructive commands (expect: REJECTED)"
for cmd in "${DESTRUCTIVE[@]}"; do
    if run_one "$cmd"; then
        bad "$cmd  →  PASSED (gate failed!)"
        PASSED_DESTRUCTIVE=$((PASSED_DESTRUCTIVE+1))
    else
        EC=$?
        if [ "$EC" -eq 2 ]; then
            ok "$cmd  →  REJECTED"
            BLOCKED_DESTRUCTIVE=$((BLOCKED_DESTRUCTIVE+1))
        elif [ "$EC" -eq 127 ]; then
            note "$cmd  →  PASSED (binary not installed; counted as passed gate)"
            PASSED_DESTRUCTIVE=$((PASSED_DESTRUCTIVE+1))
        else
            note "$cmd  →  exit=$EC (treating as gate-pass)"
            PASSED_DESTRUCTIVE=$((PASSED_DESTRUCTIVE+1))
        fi
    fi
done

echo
note "safe commands (expect: PASS)"
for cmd in "${SAFE[@]}"; do
    if run_one "$cmd"; then
        ok "$cmd  →  PASS"
        PASSED_SAFE=$((PASSED_SAFE+1))
    else
        EC=$?
        if [ "$EC" -eq 2 ]; then
            bad "$cmd  →  REJECTED (false positive)"
            BLOCKED_SAFE=$((BLOCKED_SAFE+1))
        elif [ "$EC" -eq 127 ]; then
            ok "$cmd  →  PASS (binary not installed)"
            PASSED_SAFE=$((PASSED_SAFE+1))
        else
            ok "$cmd  →  PASS (exit=$EC)"
            PASSED_SAFE=$((PASSED_SAFE+1))
        fi
    fi
done

# ----------------------------------------------------------------------

step "5. Benchmark summary"
TOTAL_DEST=${#DESTRUCTIVE[@]}
TOTAL_SAFE=${#SAFE[@]}

# Latency stats via python
read MIN_LAT MAX_LAT AVG_LAT <<< $(python3 -c "
lat=[$(IFS=,; echo "${LATENCIES[*]}")]
print(min(lat), max(lat), sum(lat)//len(lat))
")

echo
note "Wrap step:           ${WRAP_TIME}s"
note "Ontology facts:      $FACTS"
note "Destructive blocked: $BLOCKED_DESTRUCTIVE / $TOTAL_DEST"
note "Safe pass-through:   $PASSED_SAFE / $TOTAL_SAFE"
note "Gate latency:        avg ${AVG_LAT}ms / min ${MIN_LAT}ms / max ${MAX_LAT}ms"
echo
note "Without mcp-former:  every destructive verb runs the underlying"
note "                     CLI and (potentially) deletes data."
note "With mcp-former:     ${BLOCKED_DESTRUCTIVE}/${TOTAL_DEST} destructive verbs blocked at the gate"
note "                     before they reach the underlying CLI."

# ----------------------------------------------------------------------

step "6. Wire into Claude Code"
echo "  Add to ~/.claude/mcp.json:"
echo
cat <<EOF | sed 's/^/  /'
{
  "mcpServers": {
    "$NAME-mcpf": {
      "command": "python3",
      "args": ["$WORK/bundle/mcp_server.py"]
    }
  }
}
EOF

echo
echo -e "${GREEN}done.${NC} Bundle at: $WORK/bundle"
