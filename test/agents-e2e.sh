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

# Bare "origin" so a real `git push` (part of the PR flow) works fully offline.
ORIGIN="$(mktemp -d)/origin.git"
git init --bare -q "$ORIGIN"
git -C "$REPO" remote add origin "$ORIGIN"

start() { # start [extra env...] -- [server args...]
  env "$@" NO_OPEN=1 PORT=$PORT KANBAN_CLAUDE_BIN="$ROOT/test/fake-claude" KANBAN_GH_BIN="$ROOT/test/fake-gh" \
    node "$ROOT/bin/serve.mjs" "$REPO" ${AGENTS_FLAG:-} & PID=$!; sleep 1
}
stop_srv() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; PID=""; }
jget() { jexpr "$(curl -s "localhost:$PORT$1")" "$2"; }
# jexpr JSON_STRING EXPR — same as jget but evals against an already-captured JSON body.
jexpr() { node -e "const b=JSON.parse(process.argv[1]);console.log(eval(process.argv[2]))" "$1" "$2"; }
# post_pr ID — POST /api/sessions/ID/pr, sets $pr_code and $pr_body.
post_pr() {
  local resp; resp="$(curl -s -w '\n%{http_code}' -X POST "localhost:$PORT/api/sessions/$1/pr")"
  pr_code="$(printf '%s' "$resp" | tail -n1)"
  pr_body="$(printf '%s' "$resp" | sed '$d')"
}

# --- happy path -------------------------------------------------------------
AGENTS_FLAG=--agents start
assert_eq "$(curl -s -X POST localhost:$PORT/api/cards/api%2Fdo-thing/work)" '{"ok":true}' "dispatch"
sleep 2
assert_eq "$(jget /api/board "b.sessions['api/do-thing'].status")" "review" "status after run"
assert_eq "$(jget /api/board "b.sessions['api/do-thing'].commits")" "1" "one commit"
assert_eq "$(jget /api/board "b.hasOrigin")" "true" "hasOrigin true"
assert_eq "$(jget /api/board "b.requirePr")" "false" "requirePr false"
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
assert_eq "$(jget /api/board "'requirePr' in b")" "false" "no requirePr key"
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

# --- diff viewer + PR happy path ---
AGENTS_FLAG=--agents start
printf "PR card\n" > "$REPO/.kanban/todo/api/pr-thing.md"
assert_eq "$(curl -s -X POST localhost:$PORT/api/cards/api%2Fpr-thing/work)" '{"ok":true}' "dispatch(pr-thing)"
sleep 2
assert_eq "$(jget /api/board "b.sessions['api/pr-thing'].status")" "review" "pr-thing in review"

assert_eq "$(jget /api/sessions/api%2Fpr-thing/diff "b.diff.includes('fake-work.txt')")" "true" "diff includes fake-work.txt"
assert_eq "$(jget /api/sessions/api%2Fpr-thing/diff "b.diff.split('\n').some(l=>l.startsWith('+done:'))")" "true" "diff has +done: content line"
assert_eq "$(jget /api/sessions/api%2Fpr-thing/diff "b.truncated")" "false" "diff not truncated"

post_pr api%2Fpr-thing
assert_eq "$pr_code" "200" "pr create → 200"
assert_eq "$(jexpr "$pr_body" "!!b.url")" "true" "pr response has a url"
assert_eq "$(jget /api/board "b.sessions['api/pr-thing'].status")" "pr" "session status pr after PR"
assert_eq "$(jget /api/board "!!b.sessions['api/pr-thing'].prUrl")" "true" "prUrl set on session"
[ -f "$REPO/.kanban/doing/api/pr-thing.md" ] || fail "pr card should stay in doing, not move"
assert_eq "$(git -C "$REPO" branch --list 'kanban/api--pr-thing' | wc -l | tr -d ' ')" "1" "local pr branch preserved"
assert_eq "$(node -e "console.log(require('fs').existsSync(require('path').join(require('os').tmpdir(),'dot-kanban-agents','fixture','api--pr-thing')))")" "false" "worktree cleaned up after pr"
assert_eq "$(git -C "$ORIGIN" branch --list 'kanban/*' | wc -l | tr -d ' ')" "1" "origin received the pushed branch"
assert_eq "$(jget /api/sessions/api%2Fpr-thing/diff "b.diff.includes('fake-work.txt')")" "true" "diff still served in pr state (worktree gone)"

# --- discard a pr-status session: branch + metadata gone, card returns to todo ---
assert_eq "$(curl -s -X POST localhost:$PORT/api/sessions/api%2Fpr-thing/discard)" '{"ok":true}' "discard pr-status session"
[ -f "$REPO/.kanban/todo/api/pr-thing.md" ] || fail "discarded pr card should return to todo"
assert_eq "$(git -C "$REPO" branch --list 'kanban/api--pr-thing' | wc -l | tr -d ' ')" "0" "pr branch removed by discard"
assert_eq "$(jget /api/board "'api/pr-thing' in (b.sessions||{})")" "false" "pr session metadata removed by discard"

# --- PR with no origin remote ---
git -C "$REPO" remote remove origin
assert_eq "$(jget /api/board "b.hasOrigin")" "false" "hasOrigin false"
printf "no origin card\n" > "$REPO/.kanban/todo/api/pr-noorigin.md"
assert_eq "$(curl -s -X POST localhost:$PORT/api/cards/api%2Fpr-noorigin/work)" '{"ok":true}' "dispatch(pr-noorigin)"
sleep 2
assert_eq "$(jget /api/board "b.sessions['api/pr-noorigin'].status")" "review" "pr-noorigin in review"
post_pr api%2Fpr-noorigin
assert_eq "$pr_code" "409" "pr with no origin → 409"
assert_eq "$(jexpr "$pr_body" "/origin/i.test(b.error)")" "true" "no-origin error mentions origin"
git -C "$REPO" remote add origin "$ORIGIN"
stop_srv

# --- PR when gh CLI fails (e.g. unauthenticated) ---
AGENTS_FLAG=--agents start FAKE_GH_FAIL=1
printf "gh fail card\n" > "$REPO/.kanban/todo/api/pr-ghfail.md"
assert_eq "$(curl -s -X POST localhost:$PORT/api/cards/api%2Fpr-ghfail/work)" '{"ok":true}' "dispatch(pr-ghfail)"
sleep 2
assert_eq "$(jget /api/board "b.sessions['api/pr-ghfail'].status")" "review" "pr-ghfail in review"
post_pr api%2Fpr-ghfail
assert_eq "$pr_code" "409" "pr with gh failure → 409"
assert_eq "$(jexpr "$pr_body" "/not authenticated/.test(b.error)")" "true" "gh failure stderr surfaced in error"
assert_eq "$(jget /api/board "b.sessions['api/pr-ghfail'].status")" "review" "status stays review after gh failure (retryable)"
[ -f "$REPO/.kanban/doing/api/pr-ghfail.md" ] || fail "pr-ghfail card should still be in doing"
curl -s -X POST localhost:$PORT/api/sessions/api%2Fpr-ghfail/discard >/dev/null
stop_srv

# --- require-pr gate ---
AGENTS_FLAG="--agents --require-pr" start
printf "require pr card\n" > "$REPO/.kanban/todo/api/require-pr-card.md"
assert_eq "$(curl -s -X POST localhost:$PORT/api/cards/api%2Frequire-pr-card/work)" '{"ok":true}' "dispatch(require-pr-card)"
sleep 2
assert_eq "$(jget /api/board "b.sessions['api/require-pr-card'].status")" "review" "require-pr-card in review"
assert_eq "$(jget /api/board "b.requirePr")" "true" "requirePr true"
resp="$(curl -s -w '\n%{http_code}' -X POST localhost:$PORT/api/sessions/api%2Frequire-pr-card/merge)"
merge_code="$(printf '%s' "$resp" | tail -n1)"
merge_body="$(printf '%s' "$resp" | sed '$d')"
assert_eq "$merge_code" "409" "merge gated by require-pr → 409"
assert_eq "$(jexpr "$merge_body" "/require-pr/.test(b.error) && /Open PR/.test(b.error)")" "true" "gate error mentions require-pr and Open PR"
assert_eq "$(jget /api/board "b.sessions['api/require-pr-card'].status")" "review" "still review after gated merge"
[ -f "$REPO/.kanban/doing/api/require-pr-card.md" ] || fail "require-pr-card should stay in doing"
post_pr api%2Frequire-pr-card
assert_eq "$pr_code" "200" "pr still works under require-pr"
curl -s -X POST localhost:$PORT/api/sessions/api%2Frequire-pr-card/discard >/dev/null
stop_srv

# --- require-pr via env var ---
AGENTS_FLAG=--agents start KANBAN_REQUIRE_PR=1
assert_eq "$(jget /api/board "b.requirePr")" "true" "requirePr true via env"
stop_srv

echo PASS
