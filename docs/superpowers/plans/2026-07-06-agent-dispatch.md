# Agent Dispatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind an opt-in `--agents` flag, the kanban web UI can spawn, watch, stop, and merge headless Claude Code sessions that work cards in isolated git worktrees.

**Architecture:** A new session-manager module (`bin/agents.mjs`) shells out to `claude -p --output-format stream-json` with `cwd` in a server-created worktree (`git worktree add -b kanban/<flat-id>`), parses the event stream into a human log, and persists durable state to `.kanban/.agents/<flat-id>.json`. `bin/serve.mjs` registers agent routes only when the flag is on; the UI drives everything off the existing 3-second board poll plus a per-panel log poll. A committed fake-`claude` shim makes the whole cycle deterministically testable without tokens.

**Tech Stack:** Node stdlib only (`child_process`, `fs/promises`, `os`), vanilla-JS single-file UI, bash e2e script.

**Spec:** `docs/superpowers/specs/2026-07-06-agent-dispatch-design.md` (approved; authoritative for lifecycle, briefing, and edge cases).

## Global Constraints

- Zero dependencies. `ui/index.html` stays one self-contained file.
- Everything agent-related is gated: flag off ⇒ agent routes absent (404), board payload has `agents: false` and no `sessions` key, UI renders no agent controls — byte-identical behavior to v1.2.0 except the (unconditional) `127.0.0.1` bind, removed CORS wildcard, and the `agents` field itself.
- Flag: `--agents` anywhere in argv, or `KANBAN_AGENTS=1`. Board-path positional arg must still work alongside flags.
- Naming: flat id = card id with `/` → `--`. Branch `kanban/<flat-id>`. Worktree `<os.tmpdir()>/dot-kanban-agents/<repo-basename>/<flat-id>`. Metadata `.kanban/.agents/<flat-id>.json`.
- Session statuses: `running`, `stopping` (transient), `review`, `failed`, `interrupted`. Cards move `todo→doing` on dispatch, `doing→done` on merge, `doing→todo` on discard; columns stay the source of truth.
- Env knobs: `KANBAN_MAX_AGENTS` (default 3), `KANBAN_AGENT_TOOLS` (default `Bash(git *),Bash(npm test*),Bash(npm run *),Bash(node *)`), `KANBAN_CLAUDE_BIN` (default `claude`; e2e points it at the shim).
- All session-derived text rendered in the UI passes through `esc()` (or `md()`, which escapes) — same convention as v1.2.0.
- No test framework (deliberate). Verification = the committed shim + curl assertions with expected output, exactly as written in each task; plus a real-`claude` manual pass and browser pass in Task 6.
- Metadata JSON shape (all tasks agree on this): `{ id, status, branch, worktree, base, startedAt, endedAt?, sessionId, cost, summary, error, commits?, diffstat? }`.

---

### Task 1: `--agents` flag, localhost bind, CORS removal

**Files:**
- Modify: `bin/serve.mjs` (argv parsing ~line 15, CORS block in the request handler, `GET /api/board`, `server.listen`)

**Interfaces:**
- Consumes: existing `findBoard()`, board route.
- Produces: global `const AGENTS` (boolean) and `const args` (argv slice) that Task 3 reuses; `GET /api/board` payload gains `agents: <bool>`.

- [ ] **Step 1: Parse flags and keep the positional path working**

At the top of `bin/serve.mjs`, above `findBoard()`, add:

```js
const args = process.argv.slice(2);
const AGENTS = args.includes("--agents") || process.env.KANBAN_AGENTS === "1";
```

In `findBoard()`, change `const arg = process.argv[2];` to:

```js
  const arg = args.find((a) => !a.startsWith("--"));
```

- [ ] **Step 2: Bind localhost, drop CORS**

Delete these lines from the request handler (they are the four lines under `// CORS for local dev` plus the OPTIONS early-return):

```js
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
```

Change the listen call to bind loopback only:

```js
server.listen(PORT, "127.0.0.1", () => {
```

- [ ] **Step 3: Expose the flag on the board payload**

In the `GET /api/board` handler, after `b.project = PROJECT;` add:

```js
      b.agents = AGENTS;
```

- [ ] **Step 4: Verify**

```bash
NO_OPEN=1 PORT=4141 node bin/serve.mjs . & sleep 1
curl -s localhost:4141/api/board | node -e "const b=JSON.parse(require('fs').readFileSync(0));console.log('agents:',b.agents)"
# expect: agents: false
lsof -nP -iTCP:4141 -sTCP:LISTEN | tail -1
# expect: the address column shows 127.0.0.1:4141 (not *:4141)
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS localhost:4141/api/board
# expect: 404 (OPTIONS handling removed)
kill %1
NO_OPEN=1 PORT=4141 node bin/serve.mjs . --agents & sleep 1
curl -s localhost:4141/api/board | node -e "const b=JSON.parse(require('fs').readFileSync(0));console.log('agents:',b.agents)"
# expect: agents: true  (positional path arg + flag coexist)
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add bin/serve.mjs
git commit -m "feat(server): --agents flag, bind 127.0.0.1, drop CORS wildcard"
```

---

### Task 2: Session manager (`bin/agents.mjs`) + fake-claude shim

**Files:**
- Create: `bin/agents.mjs`
- Create: `test/fake-claude` (executable)

**Interfaces:**
- Consumes: nothing from other tasks (standalone module).
- Produces (Task 3 relies on exactly these): `createAgentManager({ board, repoRoot }) -> { init(), dispatch(id, {title, body, project}), stop(id), merge(id), discard(id), log(id), sessions() }`. All methods async except `log`/`sessions` (async too — both return Promises). Errors carry `e.code`: `"limit" | "exists" | "state" | "conflict"`; anything else is a 500. `sessions()` returns `{ [cardId]: {status, cost, branch, summary, error, sessionId, commits, diffstat, startedAt} }`. `dispatch` on a card whose metadata is `failed`/`interrupted` acts as retry (cleans up and re-dispatches).

- [ ] **Step 1: Write `bin/agents.mjs`**

```js
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX = parseInt(process.env.KANBAN_MAX_AGENTS || "3", 10);
const TOOLS = process.env.KANBAN_AGENT_TOOLS || "Bash(git *),Bash(npm test*),Bash(npm run *),Bash(node *)";
const LOG_CAP = 2000;

export function createAgentManager({ board, repoRoot }) {
  const bin = process.env.KANBAN_CLAUDE_BIN || "claude";
  const metaDir = join(board, ".agents");
  const live = new Map(); // flatId -> { child, log: [], meta }

  const flat = (id) => id.replace(/\//g, "--");
  const metaPath = (id) => join(metaDir, `${flat(id)}.json`);
  const wtPath = (id) => join(tmpdir(), "dot-kanban-agents", basename(repoRoot), flat(id));
  const branchOf = (id) => `kanban/${flat(id)}`;

  const git = async (a, cwd = repoRoot) => (await exec("git", a, { cwd })).stdout.trim();

  async function readMeta(id) {
    try { return JSON.parse(await readFile(metaPath(id), "utf8")); } catch { return null; }
  }
  async function writeMeta(meta) {
    await mkdir(metaDir, { recursive: true });
    await writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2) + "\n");
  }

  // Sessions left "running" by a dead server are interrupted
  async function init() {
    if (!existsSync(metaDir)) return;
    for (const f of (await readdir(metaDir)).filter((f) => f.endsWith(".json"))) {
      try {
        const meta = JSON.parse(await readFile(join(metaDir, f), "utf8"));
        if (meta.status === "running" || meta.status === "stopping") {
          meta.status = "interrupted";
          meta.error = "server restarted while session was running";
          await writeMeta(meta);
        }
      } catch {}
    }
  }

  async function cleanupArtifacts(id) {
    await git(["worktree", "remove", "--force", wtPath(id)]).catch(() => {});
    await rm(wtPath(id), { recursive: true, force: true }).catch(() => {});
    await git(["worktree", "prune"]).catch(() => {});
    await git(["branch", "-D", branchOf(id)]).catch(() => {});
  }

  function pushLog(entry, line) {
    entry.log.push(line);
    if (entry.log.length > LOG_CAP) entry.log.splice(0, entry.log.length - LOG_CAP);
  }

  function handleEvent(entry, ev) {
    if (ev.session_id && !entry.meta.sessionId) entry.meta.sessionId = ev.session_id;
    if (ev.type === "assistant" && ev.message?.content) {
      for (const c of ev.message.content) {
        if (c.type === "text" && c.text) pushLog(entry, c.text);
        if (c.type === "tool_use") pushLog(entry, `⚙ ${c.name}`);
      }
    }
    if (ev.type === "result") {
      entry.meta.cost = ev.total_cost_usd ?? null;
      entry.meta.summary = ev.result || "";
    }
  }

  async function dispatch(id, card) {
    // count by explicit done flag: signal-killed children keep exitCode === null
    const running = [...live.values()].filter((e) => !e.done).length;
    if (running >= MAX) { const e = new Error(`agent limit (${MAX}) reached`); e.code = "limit"; throw e; }
    const prior = await readMeta(id);
    if (prior && !["failed", "interrupted"].includes(prior.status)) {
      const e = new Error(`session already ${prior.status}`); e.code = "exists"; throw e;
    }
    await git(["rev-parse", "--git-dir"]); // throws if repo missing
    await cleanupArtifacts(id); // idempotent; clears failed/interrupted remnants
    await rm(metaPath(id), { force: true });
    const wt = wtPath(id);
    await mkdir(join(tmpdir(), "dot-kanban-agents", basename(repoRoot)), { recursive: true });
    const base = await git(["rev-parse", "HEAD"]);
    await git(["worktree", "add", "-b", branchOf(id), wt, "HEAD"]);
    const meta = {
      id, status: "running", branch: branchOf(id), worktree: wt, base,
      startedAt: new Date().toISOString(), sessionId: null, cost: null, summary: null, error: null,
    };
    await writeMeta(meta);
    const briefing = [
      `You are a kanban worker dispatched from the dot-kanban board for the repository "${basename(repoRoot)}".`,
      `Card: "${card.title}"${card.project ? ` (project: ${card.project})` : ""}.`,
      `You are working in an isolated git worktree on branch ${meta.branch}; the user's checkout is untouched.`,
      `Do the work the card describes. Commit your changes to this branch as you go, with clear messages. Never push, never switch branches, never touch files outside this worktree.`,
      `If a command you need is not permitted, the run aborts - prefer the allowed tools.`,
      `When finished, end with a concise summary of what you did and how you verified it; the user reviews that summary on the card before merging your branch.`,
    ].join("\n");
    const child = spawn(bin, [
      "-p", `${card.title}\n\n${card.body || ""}`,
      "--output-format", "stream-json",
      "--permission-mode", "acceptEdits",
      "--allowedTools", TOOLS,
      "--append-system-prompt", briefing,
    ], { cwd: wt, stdio: ["ignore", "pipe", "pipe"] });
    const entry = { child, log: [], meta, done: false };
    live.set(flat(id), entry);
    let buf = "", errBuf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { handleEvent(entry, JSON.parse(line)); } catch { pushLog(entry, line); }
      }
    });
    child.stderr.on("data", (d) => { errBuf = (errBuf + d).slice(-2000); });
    child.on("error", async (err) => {
      entry.done = true;
      meta.status = "failed"; meta.error = `could not start ${bin}: ${err.message}`;
      meta.endedAt = new Date().toISOString();
      await writeMeta(meta);
    });
    child.on("close", async (code) => {
      entry.done = true;
      const rest = buf.trim();
      if (rest) { try { handleEvent(entry, JSON.parse(rest)); } catch { pushLog(entry, rest); } buf = ""; }
      meta.endedAt = new Date().toISOString();
      if (meta.status === "stopping") { meta.status = "failed"; meta.error = "stopped by user"; }
      else if (meta.status === "failed") { /* spawn error already recorded by the error handler */ }
      else if (code === 0) {
        const n = parseInt(await git(["rev-list", "--count", `${meta.base}..${meta.branch}`]).catch(() => "0"), 10);
        meta.commits = n;
        meta.diffstat = n ? await git(["diff", "--stat", `${meta.base}..${meta.branch}`]).catch(() => "") : "";
        meta.status = "review";
      } else {
        meta.status = "failed";
        meta.error = errBuf.trim().split("\n").pop() || `exit code ${code}`;
      }
      await writeMeta(meta);
    });
    return meta;
  }

  async function stop(id) {
    const entry = live.get(flat(id));
    if (!entry || entry.done || entry.meta.status !== "running") { const e = new Error("not running"); e.code = "state"; throw e; }
    entry.meta.status = "stopping";
    await writeMeta(entry.meta);
    entry.child.kill("SIGTERM");
  }

  async function merge(id) {
    const meta = await readMeta(id);
    if (!meta || meta.status !== "review") { const e = new Error("not in review"); e.code = "state"; throw e; }
    if (!meta.commits) { const e = new Error("no changes to merge"); e.code = "state"; throw e; }
    try {
      await git(["merge", "--no-ff", "--no-edit", meta.branch]);
    } catch {
      await git(["merge", "--abort"]).catch(() => {});
      const e = new Error(`merge conflicts - resolve manually; branch preserved: ${meta.branch}`);
      e.code = "conflict"; throw e;
    }
    await cleanupArtifacts(id);
    await rm(metaPath(id), { force: true });
    live.delete(flat(id));
  }

  async function discard(id) {
    const meta = await readMeta(id);
    if (!meta || !["review", "failed", "interrupted"].includes(meta.status)) {
      const e = new Error("nothing to discard"); e.code = "state"; throw e;
    }
    await cleanupArtifacts(id);
    await rm(metaPath(id), { force: true });
    live.delete(flat(id));
  }

  async function log(id) {
    const entry = live.get(flat(id));
    if (entry) return entry.log.slice(-400).join("\n");
    const meta = await readMeta(id);
    return meta?.summary || meta?.error || "";
  }

  async function sessions() {
    const out = {};
    if (!existsSync(metaDir)) return out;
    for (const f of (await readdir(metaDir)).filter((f) => f.endsWith(".json"))) {
      try {
        const m = JSON.parse(await readFile(join(metaDir, f), "utf8"));
        out[m.id] = {
          status: m.status, cost: m.cost, branch: m.branch, summary: m.summary,
          error: m.error, sessionId: m.sessionId, commits: m.commits ?? null,
          diffstat: m.diffstat ?? null, startedAt: m.startedAt,
        };
      } catch {}
    }
    return out;
  }

  return { init, dispatch, stop, merge, discard, log, sessions };
}
```

- [ ] **Step 2: Write `test/fake-claude`**

A stand-in for the real CLI: emits scripted stream-json, commits a file in its cwd (the worktree), honors failure injection.

```js
#!/usr/bin/env node
// Fake claude CLI for deterministic e2e tests. Mimics: claude -p <prompt> --output-format stream-json ...
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";
const sleepS = parseFloat(process.env.FAKE_CLAUDE_SLEEP || "0");

out({ type: "system", subtype: "init", session_id: "fake-session-123" });
out({ type: "assistant", message: { content: [{ type: "text", text: `Working on: ${prompt.split("\n")[0]}` }] } });

if (process.env.FAKE_CLAUDE_FAIL === "1") {
  process.stderr.write("Permission denied: Bash(curl *) is not allowed\n");
  process.exit(2);
}

if (sleepS) await new Promise((r) => setTimeout(r, sleepS * 1000));

out({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", id: "t1", input: {} }] } });
writeFileSync("fake-work.txt", `done: ${prompt.split("\n")[0]}\n`);
execFileSync("git", ["add", "fake-work.txt"]);
execFileSync("git", ["commit", "-m", "fake: complete card work"], { env: { ...process.env, GIT_AUTHOR_NAME: "fake", GIT_AUTHOR_EMAIL: "f@ke", GIT_COMMITTER_NAME: "fake", GIT_COMMITTER_EMAIL: "f@ke" } });
const result = { type: "result", subtype: "success", session_id: "fake-session-123", total_cost_usd: 0.0123, result: "Implemented the card: created fake-work.txt and committed it. Verified by inspection." };
if (process.env.FAKE_CLAUDE_NO_NEWLINE === "1") process.stdout.write(JSON.stringify(result));
else out(result);
```

Then: `chmod +x test/fake-claude`.

- [ ] **Step 3: Verify the manager standalone (shim, no server)**

```bash
SCRATCH=/private/tmp/claude-501/-Users-dylangroos-claude-kanban/d503d7a6-be2d-4168-9980-329fc1197d24/scratchpad
REPO=$SCRATCH/agent-fixture
rm -rf $REPO && mkdir -p $REPO/.kanban/todo/api $REPO/.kanban/doing $REPO/.kanban/done
printf "Add a fake file.\n" > $REPO/.kanban/todo/api/do-thing.md
git -C $REPO init -q && git -C $REPO add -A && git -C $REPO -c user.email=t@t -c user.name=t commit -qm init

KANBAN_CLAUDE_BIN=$PWD/test/fake-claude node --input-type=module -e "
import { createAgentManager } from '$PWD/bin/agents.mjs';
const m = createAgentManager({ board: '$REPO/.kanban', repoRoot: '$REPO' });
await m.init();
await m.dispatch('api/do-thing', { title: 'do thing', body: 'Add a fake file.', project: 'api' });
await new Promise(r => setTimeout(r, 1500));
console.log('sessions:', JSON.stringify(await m.sessions(), null, 1));
console.log('log:', await m.log('api/do-thing'));
await m.merge('api/do-thing');
console.log('merged. HEAD:');
"
git -C $REPO log --oneline -2
ls $REPO/fake-work.txt && git -C $REPO branch --list 'kanban/*'
```

Expected: sessions shows `api/do-thing` with `status: "review"`, `cost: 0.0123`, `commits: 1`, a one-line diffstat; log contains "Working on: do thing" and "⚙ Edit"; after merge, `git log` shows a merge commit + `fake: complete card work`, `fake-work.txt` exists in the repo root, and `branch --list` prints nothing (cleaned up). The `.kanban/.agents/` dir is empty (metadata removed on merge).

Also verify the failure path:

```bash
FAKE_CLAUDE_FAIL=1 KANBAN_CLAUDE_BIN=$PWD/test/fake-claude node --input-type=module -e "
import { createAgentManager } from '$PWD/bin/agents.mjs';
const m = createAgentManager({ board: '$REPO/.kanban', repoRoot: '$REPO' });
await m.dispatch('api/do-thing', { title: 'do thing', body: '', project: 'api' });
await new Promise(r => setTimeout(r, 1500));
console.log(JSON.stringify((await m.sessions())['api/do-thing']));
await m.discard('api/do-thing');
"
```

Expected: `status: "failed"`, `error: "Permission denied: Bash(curl *) is not allowed"`; discard cleans up without error.

- [ ] **Step 4: Commit**

```bash
git add bin/agents.mjs test/fake-claude
git commit -m "feat(agents): session manager with worktree isolation + fake-claude shim"
```

---

### Task 3: Agent routes and board payload

**Files:**
- Modify: `bin/serve.mjs` (import, manager construction, routes, board payload)

**Interfaces:**
- Consumes: Task 1's `AGENTS`; Task 2's `createAgentManager` exactly as specified; existing helpers `cardPath`, `splitId`, `pruneEmpty`, `parseFrontmatter`, `json`, `COLUMNS`, `BOARD`.
- Produces (Task 4 relies on these): board payload `sessions` map (flag on only); `POST /api/cards/:id/work`; `POST /api/sessions/:id/{stop,merge,discard,retry}`; `GET /api/sessions/:id/log` → `{log}`. Error responses: `{error}` with 409 for codes `limit|exists|state|conflict`, 404 for missing card, 500 otherwise.

- [ ] **Step 1: Construct the manager (flag-gated)**

After the `PROJECT` constant in `bin/serve.mjs`:

```js
import { createAgentManager } from "./agents.mjs";
```

(with the other imports), and after the board-dirs bootstrap:

```js
const REPO_ROOT = resolve(BOARD, "..");
const agents = AGENTS ? createAgentManager({ board: BOARD, repoRoot: REPO_ROOT }) : null;
if (agents) await agents.init();
```

- [ ] **Step 2: Board payload**

In `GET /api/board`, after `b.agents = AGENTS;`:

```js
      if (agents) b.sessions = await agents.sessions();
```

- [ ] **Step 3: Dispatch route**

Add with the other routes (all agent routes wrapped in `if (AGENTS && ...)`):

```js
    // API: POST /api/cards/:id/work — dispatch an agent on a todo card
    if (AGENTS && path.match(/^\/api\/cards\/[^/]+\/work$/) && req.method === "POST") {
      const id = decodeURIComponent(path.split("/")[3]);
      const src = cardPath("todo", id);
      if (!existsSync(src)) return json(res, { error: "card not in todo" }, 404);
      const { project, slug } = splitId(id);
      const { body: cardBody } = parseFrontmatter(await readFile(src));
      const dst = cardPath("doing", id);
      await mkdir(dirname(dst), { recursive: true });
      await rename(src, dst);
      await pruneEmpty("todo", id);
      try {
        await agents.dispatch(id, { title: slug.replace(/-/g, " "), body: cardBody, project });
      } catch (err) {
        // undo the column move so the board reflects reality
        await mkdir(dirname(src), { recursive: true });
        await rename(dst, src).catch(() => {});
        await pruneEmpty("doing", id);
        return json(res, { error: err.message }, ["limit", "exists"].includes(err.code) ? 409 : 500);
      }
      return json(res, { ok: true });
    }
```

- [ ] **Step 4: Session action routes**

```js
    // API: POST /api/sessions/:id/(stop|merge|discard|retry), GET /api/sessions/:id/log
    if (AGENTS && path.match(/^\/api\/sessions\/[^/]+\/[a-z]+$/)) {
      const [, , , rawId, action] = path.split("/");
      const id = decodeURIComponent(rawId);
      try {
        if (action === "log" && req.method === "GET") return json(res, { log: await agents.log(id) });
        if (req.method !== "POST") return json(res, { error: "method" }, 405);
        if (action === "stop") { await agents.stop(id); return json(res, { ok: true }); }
        if (action === "merge") {
          await agents.merge(id);
          const from = cardPath("doing", id);
          if (existsSync(from)) {
            const dst = cardPath("done", id);
            await mkdir(dirname(dst), { recursive: true });
            await rename(from, dst);
            await pruneEmpty("doing", id);
          }
          return json(res, { ok: true });
        }
        if (action === "discard") {
          await agents.discard(id);
          const from = cardPath("doing", id);
          if (existsSync(from)) {
            const dst = cardPath("todo", id);
            await mkdir(dirname(dst), { recursive: true });
            await rename(from, dst);
            await pruneEmpty("doing", id);
          }
          return json(res, { ok: true });
        }
        if (action === "retry") {
          const src = cardPath("doing", id);
          if (!existsSync(src)) return json(res, { error: "card not in doing" }, 404);
          const { project, slug } = splitId(id);
          const { body: cardBody } = parseFrontmatter(await readFile(src));
          await agents.dispatch(id, { title: slug.replace(/-/g, " "), body: cardBody, project });
          return json(res, { ok: true });
        }
        return json(res, { error: "unknown action" }, 404);
      } catch (err) {
        return json(res, { error: err.message }, ["limit", "exists", "state", "conflict"].includes(err.code) ? 409 : 500);
      }
    }
```

- [ ] **Step 5: Verify the full curl cycle against the shim**

```bash
SCRATCH=/private/tmp/claude-501/-Users-dylangroos-claude-kanban/d503d7a6-be2d-4168-9980-329fc1197d24/scratchpad
REPO=$SCRATCH/agent-fixture
rm -rf $REPO && mkdir -p $REPO/.kanban/todo/api
printf "Add a fake file.\n" > $REPO/.kanban/todo/api/do-thing.md
printf "Another.\n" > $REPO/.kanban/todo/api/second-thing.md
git -C $REPO init -q && git -C $REPO add -A && git -C $REPO -c user.email=t@t -c user.name=t commit -qm init
KANBAN_CLAUDE_BIN=$PWD/test/fake-claude NO_OPEN=1 PORT=4143 node bin/serve.mjs $REPO --agents & sleep 1

curl -s -X POST localhost:4143/api/cards/api%2Fdo-thing/work            # {"ok":true}
sleep 2
curl -s localhost:4143/api/board | node -e "const b=JSON.parse(require('fs').readFileSync(0));console.log(b.sessions['api/do-thing'].status, b.sessions['api/do-thing'].cost, b.sessions['api/do-thing'].commits)"
# expect: review 0.0123 1
curl -s localhost:4143/api/sessions/api%2Fdo-thing/log | node -e "const j=JSON.parse(require('fs').readFileSync(0));console.log(j.log.includes('Working on'))"
# expect: true
curl -s -X POST localhost:4143/api/sessions/api%2Fdo-thing/merge        # {"ok":true}
ls $REPO/.kanban/done/api/do-thing.md $REPO/fake-work.txt               # both exist
git -C $REPO branch --list 'kanban/*' | wc -l                           # 0

# failure + retry-as-dispatch + discard path
kill %1
FAKE_CLAUDE_FAIL=1 KANBAN_CLAUDE_BIN=$PWD/test/fake-claude NO_OPEN=1 PORT=4143 node bin/serve.mjs $REPO --agents & sleep 1
curl -s -X POST localhost:4143/api/cards/api%2Fsecond-thing/work && sleep 2
curl -s localhost:4143/api/board | node -e "const b=JSON.parse(require('fs').readFileSync(0));const s=b.sessions['api/second-thing'];console.log(s.status,'|',s.error)"
# expect: failed | Permission denied: Bash(curl *) is not allowed
curl -s -X POST localhost:4143/api/sessions/api%2Fsecond-thing/discard  # {"ok":true}
ls $REPO/.kanban/todo/api/second-thing.md                               # back in todo
# dispatch a card that isn't in todo → 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4143/api/cards/api%2Fdo-thing/work   # 404
kill %1

# flag OFF: agent surface gone
NO_OPEN=1 PORT=4143 node bin/serve.mjs $REPO & sleep 1
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4143/api/cards/api%2Fsecond-thing/work  # 404
curl -s localhost:4143/api/board | node -e "const b=JSON.parse(require('fs').readFileSync(0));console.log('agents' in b, 'sessions' in b)"
# expect: true false
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add bin/serve.mjs
git commit -m "feat(server): agent dispatch, session actions, and board sessions payload"
```

---

### Task 4: UI — work button, status chips, session panel

**Files:**
- Modify: `ui/index.html` (CSS, `card()`, new `work()`/`sact()`/`renderSess()`, `open_()`, `close_()`, `render()`, panel markup)

**Interfaces:**
- Consumes: board payload `agents`, `sessions`; Task 3 endpoints. Session statuses `running|stopping|review|failed|interrupted`.
- Produces: complete feature UI; nothing downstream.

- [ ] **Step 1: CSS**

Add after the `.chip .cdot` rule:

```css
.ast{display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;text-transform:uppercase;letter-spacing:.3px}
.a-running,.a-stopping{background:rgba(88,166,255,.15);color:var(--accent);animation:pulse 2s infinite}
.a-review{background:rgba(63,185,80,.15);color:var(--green)}
.a-failed,.a-interrupted{background:rgba(248,81,73,.15);color:var(--red)}
.sess{border-bottom:1px solid var(--border);padding:12px 20px;display:none;flex-shrink:0}
.sess .srow{display:flex;align-items:center;gap:10px}
.sess .scost{font-size:11px;color:var(--muted)}
.sess code{font-size:11px;background:var(--card);padding:1px 6px;border-radius:4px}
.sbtn{padding:4px 12px;border-radius:5px;border:1px solid var(--border);background:none;color:var(--text);font-size:11px;cursor:pointer}
.sbtn:hover{border-color:#444c56;background:var(--card)}
.sbtn.ok{background:var(--green);border-color:var(--green);color:#fff}
.sbtn.bad{color:var(--red);border-color:rgba(248,81,73,.4)}
.slog{margin-top:10px;max-height:200px;overflow-y:auto;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:10px;font-family:'SF Mono',Consolas,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap}
.ssum{margin-top:10px;font-size:13px}.ssum pre{margin-top:8px;font-size:11px;color:var(--muted);overflow-x:auto}
.serr{margin-top:10px;font-size:12px;color:var(--red)}
```

- [ ] **Step 2: Session strip container in the panel**

In the panel markup, between `.panel-head` and `.panel-body`:

```html
    <div class="sess" id="p-sess"></div>
```

- [ ] **Step 3: Card chips + work button**

In `card()`: add before the `return`:

```js
  const s=(B.sessions||{})[c.id];
  const st=s?`<span class="ast a-${s.status}">${s.status}</span>`:'';
  const W=(B.agents&&col==='todo'&&!s)?`<button title="Work this card with an agent" onclick="ev(event);work('${c.id}')">&#9654;</button>`:'';
```

Change the acts div to `<div class="acts">${W}${L}${R}</div>` and append `${st}` after `${pri}` in the returned card HTML.

- [ ] **Step 4: Actions + live session strip**

Add to the script (near `mv()`):

```js
async function work(id){
  const r=await fetch(`/api/cards/${encodeURIComponent(id)}/work`,{method:'POST'});
  const j=await r.json().catch(()=>({}));
  notify(r.ok?'Agent dispatched':'Dispatch failed: '+(j.error||r.status));
  prev='';load();
}
async function sact(a){
  if(!cur)return;
  if(a==='discard'&&!confirm('Discard this agent\'s work? The branch will be deleted.'))return;
  const r=await fetch(`/api/sessions/${encodeURIComponent(cur)}/${a}`,{method:'POST'});
  const j=await r.json().catch(()=>({}));
  notify(r.ok?a+' ok':a+' failed: '+(j.error||r.status));
  prev='';load();
}
let logT=null;
function renderSess(){
  const el=$('p-sess');clearInterval(logT);logT=null;
  const s=cur?(B.sessions||{})[cur]:null;
  if(!s){el.style.display='none';el.innerHTML='';return}
  el.style.display='block';
  const cost=s.cost!=null?`<span class="scost">$${s.cost.toFixed(4)}</span>`:'';
  let h=`<div class="srow"><span class="ast a-${s.status}">${s.status}</span>${cost}<code>${esc(s.branch||'')}</code><div class="sp"></div>`;
  if(s.status==='running')h+=`<button class="sbtn bad" onclick="sact('stop')">Stop</button>`;
  if(s.status==='review'){if(s.commits)h+=`<button class="sbtn ok" onclick="sact('merge')">Merge</button>`;h+=`<button class="sbtn bad" onclick="sact('discard')">Discard</button>`}
  if(s.status==='failed'||s.status==='interrupted')h+=`<button class="sbtn" onclick="sact('retry')">Retry</button><button class="sbtn bad" onclick="sact('discard')">Discard</button>`;
  h+='</div>';
  if(s.status==='review')h+=`<div class="ssum">${md(s.summary||'')}${s.commits?`<pre>${esc(s.diffstat||'')}</pre>`:'<em>no changes were committed</em>'}</div>`;
  if(s.status==='failed'&&s.error)h+=`<div class="serr">${esc(s.error)}</div>`;
  if(s.status==='interrupted')h+=`<div class="serr">Server restarted mid-session. Take over: <code>claude --resume ${esc(s.sessionId||'?')}</code></div>`;
  if(s.status==='running'||s.status==='stopping')h+=`<pre class="slog" id="slog"></pre>`;
  el.innerHTML=h;
  if(s.status==='running'||s.status==='stopping'){
    const sid=cur;
    const poll=async()=>{
      if(cur!==sid)return;
      const r=await fetch(`/api/sessions/${encodeURIComponent(sid)}/log`);
      const j=await r.json().catch(()=>({log:''}));
      if(cur!==sid)return;
      const p=$('slog');if(p){p.textContent=j.log||'';p.scrollTop=p.scrollHeight}
    };
    poll();logT=setInterval(poll,2000);
  }
}
```

Wire it in: at the end of `open_()` add `renderSess();`; in `close_()` add `clearInterval(logT);logT=null;`; at the end of `render()` add `if(cur)renderSess();` (so status flips propagate on the 3s poll).

- [ ] **Step 5: Verify (shim server + markup checks; visuals deferred)**

Restart the Task 3 shim server (`KANBAN_CLAUDE_BIN=$PWD/test/fake-claude NO_OPEN=1 PORT=4143 node bin/serve.mjs $REPO --agents`) with a fresh fixture. Confirm via `curl -s localhost:4143/ | grep -c 'p-sess'` → 1, `grep -c 'work('` ≥ 1, `grep -c 'renderSess'` ≥ 2. With the flag OFF, the served HTML is identical (the gating is data-driven via `B.agents`, not markup) — confirm `curl -s localhost:4143/api/board` has no `sessions` and the UI shows no ▶ (browser pass, Task 6). List remaining visual checks in the report: ▶ on todo cards only, pulsing running chip, live log tail, review strip with Merge/Discard, failed strip with Retry, discard confirm dialog.

- [ ] **Step 6: Commit**

```bash
git add ui/index.html
git commit -m "feat(ui): agent work button, session status chips, live session panel"
```

---

### Task 5: E2E script, docs, version bump

**Files:**
- Create: `test/agents-e2e.sh`
- Modify: `README.md`, `commands/kanban.md`, `CLAUDE.md`, `.gitignore` (create if absent), `.claude-plugin/plugin.json`, `package.json`

**Interfaces:**
- Consumes: everything above.
- Produces: `bash test/agents-e2e.sh` = one-command regression for the whole feature.

- [ ] **Step 1: Write `test/agents-e2e.sh`**

```bash
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

echo PASS
```

Then `chmod +x test/agents-e2e.sh`. (Port 4144 avoids clashing with dev servers; `start`'s env-prefix form lets the failure block inject `FAKE_CLAUDE_FAIL=1` without exporting it globally.)

- [ ] **Step 2: Run it**

```bash
bash test/agents-e2e.sh
```

Expected: `PASS` (and nothing left listening on 4144: `lsof -iTCP:4144 -sTCP:LISTEN | wc -l` → 0).

- [ ] **Step 3: Docs + version**

- `README.md`: new **Agents** section after **Projects**: enabling (`npx dot-kanban --agents` / `KANBAN_AGENTS=1`), what ▶ does (isolated worktree + branch, watch live, review diff, Merge/Discard), the env knobs (`KANBAN_MAX_AGENTS`, `KANBAN_AGENT_TOOLS`, `KANBAN_CLAUDE_BIN`), the fail-fast permission behavior, and the recommendation to add `.kanban/.agents/` to `.gitignore`. Note the server now binds `127.0.0.1`.
- `commands/kanban.md`: extend the **ui** section: `node $CLAUDE_PLUGIN_ROOT/bin/serve.mjs --agents` when the user asks for agents; mention the flag exists.
- `CLAUDE.md`: one paragraph in Repository Structure/Project Overview mentioning `bin/agents.mjs`, the `--agents` gate, and `.kanban/.agents/` metadata.
- `.gitignore`: add `.kanban/.agents/`.
- `.claude-plugin/plugin.json`: version `1.2.0` → `1.3.0`.
- `package.json`: add `"scripts": { "test:agents": "bash test/agents-e2e.sh" }` (merge into existing structure).

- [ ] **Step 4: Commit**

```bash
git add test/agents-e2e.sh README.md commands/kanban.md CLAUDE.md .gitignore .claude-plugin/plugin.json package.json
git commit -m "feat: agents e2e script, docs, and 1.3.0 version bump"
```

---

### Task 6: Final review, real-run + browser verification, PR

**Files:** none (verification + PR only)

- [ ] **Step 1: Whole-branch code review** (controller: dispatch final reviewer per the executing skill)

- [ ] **Step 2: Real-`claude` manual pass**

On a scratch git repo with a trivial card ("add a hello.txt containing hello"), run `node bin/serve.mjs <repo> --agents` with real `claude` on PATH; dispatch from the UI; confirm live log, review state with real cost, merge lands the commit. This is the only token-spending step; keep the card trivial.

- [ ] **Step 3: Browser pass** (user or Chrome tools): ▶ button gating, pulsing chip, live log tail, review strip, failed strip w/ Retry, discard confirm, and flag-off UI unchanged.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/agent-dispatch
gh pr create --title "feat: agent dispatch — board-driven Claude workers (--agents)" --body "$(cat <<'EOF'
## Summary
- Opt-in `--agents` flag (or `KANBAN_AGENTS=1`): todo cards get a ▶ button that dispatches a headless Claude Code session on the card, in an isolated git worktree + `kanban/<id>` branch
- Watchable: live log tail, status chips (running/review/failed/interrupted), Stop button; sessions survive as metadata in `.kanban/.agents/` (resume hint after server restart)
- Review-gated hand-back: worker summary + diffstat + cost in the panel; Merge (no-ff into your checkout, conflict-safe abort) or Discard; card reaches done only via merge
- Dispatch briefing injected via `--append-system-prompt` so each session knows its card, worktree, and lifecycle
- Hardening for everyone (flag-independent): server binds 127.0.0.1 and the CORS wildcard is gone
- Deterministic e2e via committed fake-claude shim: `npm run test:agents`
- Flag off ⇒ behavior identical to v1.2.0. Version → 1.3.0

Spec: `docs/superpowers/specs/2026-07-06-agent-dispatch-design.md`

## Test plan
- [ ] `bash test/agents-e2e.sh` → PASS (happy path, failure path, flag-off regression)
- [ ] Real-claude manual pass on a trivial card (live log, cost, merge)
- [ ] Browser pass (chips, log tail, review strip, discard confirm, flag-off UI unchanged)
EOF
)"
```

- [ ] **Step 5: Report the PR URL**
