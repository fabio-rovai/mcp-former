#!/bin/bash
# 60-second tour of mcp-former's git adapter.
# Requires the tardygrada daemon to be running.

set -e
cd "$(dirname "$0")/.."
PATH="$PWD/bin:$PATH"

DIM="\033[2m"
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[1;33m"
CYAN="\033[0;36m"
NC="\033[0m"

step() {
    echo
    echo -e "${CYAN}─── $1 ───${NC}"
}

# Set up sandbox repo
SANDBOX=/tmp/mcpf-git-demo
rm -rf "$SANDBOX"
mkdir -p "$SANDBOX"
cd "$SANDBOX"

git init -q
git config user.email demo@example.com
git config user.name demo
echo v1 > a.txt
git add a.txt
git commit -q -m "init"
git checkout -q -b feature-x
echo v2 > a.txt
git commit -q -am "feature"
git checkout -q main 2>/dev/null || git checkout -q master

step "Sandbox repo at $SANDBOX"
git branch

step "1. mcpf plan git — discover and classify"
mcpf plan git 2>&1 | head -25

step "2. mcpf git status — read-only, passes through"
mcpf git status

step "3. mcpf git branch -D feature-x — not protected, executes"
mcpf git branch -D feature-x

step "4. mcpf git branch -D main — REJECTED (protected_branch)"
mcpf git branch -D main || true

step "5. mcpf git push --force origin main — REJECTED (destructive_op)"
mcpf git push --force origin main || true

step "6. mcpf git --explain branch -D main — show the trace"
mcpf git --explain branch -D main || true

step "7. mcpf git --allow-unsafe branch -D main — bypass the gate"
echo -e "${YELLOW}(would execute, but git itself fails because main is current branch)${NC}"
mcpf git --allow-unsafe branch -D main 2>&1 || true

echo
echo -e "${GREEN}done.${NC} Edit ${CYAN}ontologies/git.nt${NC} to change protected branches."
