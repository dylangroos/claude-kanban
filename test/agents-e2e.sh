#!/usr/bin/env bash
# End-to-end test of agent dispatch using the fake-claude shim. Run: bash test/agents-e2e.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=4144
REPO="$(mktemp -d)/fixture"
PID=""
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; exit 1; }
assert_eq() { [ "$1" = "$2" ] || fail "$3 (got '$1', want '$2')"; }

mkdir -p "$REPO/.kanban/todo/api"
printf "Add a fake file.\n" > "$REPO/.kanban/todo/api/do-thing.md"
printf "Another.\n"        > "$REPO/.kanban/todo/api/second-thing.md"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm init

start() { # start [extra env...] -- [server args...]
  env "$@" NO_OPEN=1 PORT=$PORT KANBAN_CLAUDE_BIN="$ROOT/test/fake-claude" \
    node "$ROOT/bin/serve.mjs" "$REPO" ${AGENTS_FLAG:-} & PID=$!; sleep 1
}
stop_srv() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""; }
jget() { curl -s "localhost:$PORT$1" | node -e "const b=JSON.parse(require('fs').readFileSync(0));console.log(eval(process.argv[1]))" "$2"; }

# --- happy path -------------------------------------------------------------
AGENTS_FLAG=--agents start
assert_eq "$(curl -s -X POST localhost:$PORT/api/cards/api%2Fdo-thing/work)" '{"ok":true}' "dispatch"
sleep 2
assert_eq "$(jget /api/board "b.sessions['api/do-thing'].status")" "review" "status after run"
assert_eq "$(jget /api/board "b.sessions['api/do-thing'].commits")" "1" "one commit"
assert_eq "$(jget /api/sessions/api%2Fdo-thing/log "b.log.includes('Working on')")" "true" "log content"
assert_eq "$(curl -s -X POST localhost:$PORT/api/sessions/api%2Fdo-thing/merge)" '{"ok":true}' "merge"
[ -f "$REPO/.kanban/done/api/do-thing.md" ] || fail "card not in done"
[ -f "$REPO/fake-work.txt" ] || fail "merged work missing"
assert_eq "$(git -C "$REPO" branch --list 'kanban/*' | wc -l | tr -d ' ')" "0" "branch cleaned"
stop_srv

# --- failure + discard path -------------------------------------------------
AGENTS_FLAG=--agents start FAKE_CLAUDE_FAIL=1
assert_eq "$(curl -s -X POST localhost:$PORT/api/cards/api%2Fsecond-thing/work)" '{"ok":true}' "dispatch(fail)"
sleep 2
assert_eq "$(jget /api/board "b.sessions['api/second-thing'].status")" "failed" "failed status"
assert_eq "$(curl -s -X POST localhost:$PORT/api/sessions/api%2Fsecond-thing/discard)" '{"ok":true}' "discard"
[ -f "$REPO/.kanban/todo/api/second-thing.md" ] || fail "card not returned to todo"
assert_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:$PORT/api/cards/api%2Fdo-thing/work)" "404" "work on done card"
stop_srv

# --- flag-off regression ----------------------------------------------------
AGENTS_FLAG="" start
assert_eq "$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:$PORT/api/cards/api%2Fsecond-thing/work)" "404" "work route gated"
assert_eq "$(jget /api/board "b.agents")" "false" "agents false"
assert_eq "$(jget /api/board "'sessions' in b")" "false" "no sessions key"
stop_srv

# --- merge conflict aborts cleanly ---
AGENTS_FLAG=--agents start
printf "conflict card\n" > "$REPO/.kanban/todo/api/conflict-card.md"
# dispatch first, so the worker's worktree branches from HEAD before the user's
# conflicting commit exists — both sides then independently add fake-work.txt,
# which is an add/add conflict on merge.
assert_eq "$(curl -s -X POST localhost:$PORT/api/cards/api%2Fconflict-card/work)" '{"ok":true}' "dispatch(conflict)"
printf "user version\n" > "$REPO/fake-work.txt"
git -C "$REPO" add fake-work.txt && git -C "$REPO" -c user.email=t@t -c user.name=t commit -qm "user fake-work"
sleep 2
assert_eq "$(jget /api/board "b.sessions['api/conflict-card'].status")" "review" "conflict card in review"
before_status="$(git -C "$REPO" status --porcelain --untracked-files=no)"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST localhost:$PORT/api/sessions/api%2Fconflict-card/merge)
assert_eq "$code" "409" "merge conflict → 409"
assert_eq "$(git -C "$REPO" status --porcelain --untracked-files=no)" "$before_status" "checkout unchanged after aborted merge"
assert_eq "$(git -C "$REPO" branch --list 'kanban/api--conflict-card' | wc -l | tr -d ' ')" "1" "conflict branch preserved"
curl -s -X POST localhost:$PORT/api/sessions/api%2Fconflict-card/discard >/dev/null
stop_srv

# --- stop a running session ---
AGENTS_FLAG=--agents start FAKE_CLAUDE_SLEEP=30
printf "long card\n" > "$REPO/.kanban/todo/api/long-card.md"
curl -s -X POST localhost:$PORT/api/cards/api%2Flong-card/work >/dev/null
sleep 1
assert_eq "$(jget /api/board "b.sessions['api/long-card'].status")" "running" "long card running"
assert_eq "$(curl -s -X POST localhost:$PORT/api/sessions/api%2Flong-card/stop)" '{"ok":true}' "stop"
sleep 1
assert_eq "$(jget /api/board "b.sessions['api/long-card'].status")" "failed" "stopped → failed"
curl -s -X POST localhost:$PORT/api/sessions/api%2Flong-card/discard >/dev/null
stop_srv

echo PASS
