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
    const running = [...live.values()].filter((e) => e.child.exitCode === null).length;
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
    const entry = { child, log: [], meta };
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
      meta.status = "failed"; meta.error = `could not start ${bin}: ${err.message}`;
      meta.endedAt = new Date().toISOString();
      await writeMeta(meta);
    });
    child.on("close", async (code) => {
      meta.endedAt = new Date().toISOString();
      if (meta.status === "stopping") { meta.status = "failed"; meta.error = "stopped by user"; }
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
    if (!entry || entry.child.exitCode !== null) { const e = new Error("not running"); e.code = "state"; throw e; }
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
