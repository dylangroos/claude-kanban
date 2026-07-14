#!/usr/bin/env node

import { createServer } from "node:http";
import { readdir, readFile, rename, writeFile, unlink, mkdir, rmdir } from "node:fs/promises";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { createAgentManager } from "./agents.mjs";

const COLUMNS = ["todo", "doing", "done"];
const PORT = parseInt(process.env.PORT || "4040", 10);
const __dirname = fileURLToPath(new URL(".", import.meta.url));

const args = process.argv.slice(2);
const AGENTS = args.includes("--agents") || process.env.KANBAN_AGENTS === "1";

// Resolve board: CLI arg > env var > walk up from cwd to find .kanban/
function findBoard() {
  const arg = args.find((a) => !a.startsWith("--"));
  if (arg) return resolve(arg, ".kanban");
  if (process.env.KANBAN_DIR) return resolve(process.env.KANBAN_DIR);
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, ".kanban");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(".kanban");
}

const BOARD = findBoard();
const PROJECT = basename(resolve(BOARD, ".."));

// Ensure board dirs exist
for (const col of COLUMNS) {
  const dir = join(BOARD, col);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}

const REPO_ROOT = resolve(BOARD, "..");
const agents = AGENTS ? createAgentManager({ board: BOARD, repoRoot: REPO_ROOT }) : null;
if (agents) await agents.init();
if (agents) {
  const bye = () => { agents.shutdown(); process.exit(0); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

// Parse simple YAML frontmatter
function parseFrontmatter(raw) {
  const str = raw.toString("utf8");
  if (!str.startsWith("---\n")) return { meta: {}, body: str.trim() };
  const end = str.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: str.trim() };
  const yaml = str.slice(4, end);
  const meta = {};
  for (const line of yaml.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: str.slice(end + 5).trim() };
}

function toFrontmatter(meta, body) {
  const keys = Object.keys(meta).filter((k) => meta[k]);
  if (keys.length === 0) return body + "\n";
  const yaml = keys.map((k) => `${k}: ${meta[k]}`).join("\n");
  return `---\n${yaml}\n---\n${body}\n`;
}

// Read board state (column root + one level of project subdirs)
async function getBoard() {
  const board = {};
  const projects = new Set();
  for (const col of COLUMNS) {
    const dir = join(BOARD, col);
    board[col] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".md")) {
        board[col].push(await readCard(join(dir, e.name), e.name, null));
      } else if (e.isDirectory() && !e.name.startsWith(".")) {
        projects.add(e.name);
        const files = (await readdir(join(dir, e.name), { withFileTypes: true })).filter((f) => f.isFile() && f.name.endsWith(".md"));
        for (const f of files) {
          board[col].push(await readCard(join(dir, e.name, f.name), f.name, e.name));
        }
      }
    }
  }
  board.projects = [...projects].sort();
  return board;
}

async function readCard(path, file, project) {
  const raw = await readFile(path);
  const { meta, body } = parseFrontmatter(raw);
  const slug = file.replace(/\.md$/, "");
  return {
    id: project ? `${project}/${slug}` : slug,
    slug,
    file,
    project,
    body,
    priority: meta.priority || meta.p || null,
  };
}

// Simple slug
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Composite card ids: "project/slug" or bare "slug"
function splitId(id) {
  if (id.includes("..") || id.startsWith("/")) throw new Error("bad id");
  const i = id.indexOf("/");
  if (i === -1) return { project: null, slug: id };
  const slug = id.slice(i + 1);
  if (slug.includes("/")) throw new Error("bad id");
  return { project: id.slice(0, i), slug };
}

function cardPath(col, id) {
  const { project, slug } = splitId(id);
  return project ? join(BOARD, col, project, `${slug}.md`) : join(BOARD, col, `${slug}.md`);
}

// Remove a card's project dir if now empty (best-effort)
async function pruneEmpty(col, id) {
  const { project } = splitId(id);
  if (!project) return;
  try { await rmdir(join(BOARD, col, project)); } catch {}
}

// Next collision-free slug in a directory: slug, slug-2, slug-3, ...
function freeSlug(dir, slug) {
  let s = slug, n = 2;
  while (existsSync(join(dir, `${s}.md`))) s = `${slug}-${n++}`;
  return s;
}

// Route helpers
function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString());
}

// Serve
const server = createServer(async (req, res) => {
  // Reject cross-origin and DNS-rebinding requests: this is a localhost-only tool,
  // and the agent routes can execute code, so an attacker page must not reach us.
  const host = req.headers.host || "";
  const okHost = host === `localhost:${PORT}` || host === `127.0.0.1:${PORT}` || host === `[::1]:${PORT}`;
  const origin = req.headers.origin;
  const okOrigin = !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  if (!okHost || !okOrigin) { res.writeHead(403); res.end("forbidden"); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // API: GET /api/board
    if (path === "/api/board" && req.method === "GET") {
      const b = await getBoard();
      b.project = PROJECT;
      b.agents = AGENTS;
      if (agents) b.sessions = await agents.sessions();
      return json(res, b);
    }

    // API: POST /api/cards  { title, body?, priority?, column?, project? }
    if (path === "/api/cards" && req.method === "POST") {
      const data = await body(req);
      const col = data.column || "todo";
      if (!COLUMNS.includes(col)) return json(res, { error: "bad column" }, 400);
      const project = data.project ? slugify(data.project) : null;
      const dir = project ? join(BOARD, col, project) : join(BOARD, col);
      await mkdir(dir, { recursive: true });
      const slug = freeSlug(dir, slugify(data.title || "untitled"));
      const meta = {};
      if (data.priority) meta.priority = data.priority;
      await writeFile(join(dir, `${slug}.md`), toFrontmatter(meta, data.body || data.title || ""));
      return json(res, { ok: true, id: project ? `${project}/${slug}` : slug }, 201);
    }

    // API: PUT /api/cards/:id/move  { from, to }  (id may be "project/slug"; collisions auto-rename)
    if (path.match(/^\/api\/cards\/[^/]+\/move$/) && req.method === "PUT") {
      const id = decodeURIComponent(path.split("/")[3]);
      const data = await body(req);
      if (!COLUMNS.includes(data.from) || !COLUMNS.includes(data.to)) return json(res, { error: "bad column" }, 400);
      const { project, slug } = splitId(id);
      const dir = project ? join(BOARD, data.to, project) : join(BOARD, data.to);
      await mkdir(dir, { recursive: true });
      const s = freeSlug(dir, slug);
      await rename(cardPath(data.from, id), join(dir, `${s}.md`));
      await pruneEmpty(data.from, id);
      return json(res, { ok: true, id: project ? `${project}/${s}` : s });
    }

    // API: PUT /api/cards/:id  { body?, priority?, project? }
    if (path.match(/^\/api\/cards\/[^/]+$/) && req.method === "PUT") {
      const id = decodeURIComponent(path.split("/")[3]);
      const data = await body(req);
      let found = null;
      for (const col of COLUMNS) {
        if (existsSync(cardPath(col, id))) { found = col; break; }
      }
      if (!found) return json(res, { error: "not found" }, 404);
      const src = cardPath(found, id);
      const raw = await readFile(src);
      const parsed = parseFrontmatter(raw);
      const meta = { ...parsed.meta };
      if ("priority" in data) { meta.priority = data.priority || ""; delete meta.p; }
      const newBody = "body" in data ? data.body : parsed.body;
      let newId = id;
      if ("project" in data) {
        const { slug } = splitId(id);
        const proj = data.project ? slugify(data.project) : null;
        newId = proj ? `${proj}/${slug}` : slug;
      }
      let dst = cardPath(found, newId);
      if (dst !== src) {
        await mkdir(dirname(dst), { recursive: true });
        const { project: np, slug: ns } = splitId(newId);
        const s = freeSlug(dirname(dst), ns);
        newId = np ? `${np}/${s}` : s;
        dst = cardPath(found, newId);
      }
      await writeFile(dst, toFrontmatter(meta, newBody));
      if (dst !== src) { await unlink(src); await pruneEmpty(found, id); }
      return json(res, { ok: true, id: newId });
    }

    // API: DELETE /api/cards/:id
    if (path.match(/^\/api\/cards\/[^/]+$/) && req.method === "DELETE") {
      const id = decodeURIComponent(path.split("/")[3]);
      for (const col of COLUMNS) {
        const p = cardPath(col, id);
        if (existsSync(p)) {
          await unlink(p);
          await pruneEmpty(col, id);
          return json(res, { ok: true });
        }
      }
      return json(res, { error: "not found" }, 404);
    }

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

    // API: POST /api/sessions/:id/(stop|merge|discard|retry|pr), GET /api/sessions/:id/(log|diff)
    if (AGENTS && path.match(/^\/api\/sessions\/[^/]+\/[a-z]+$/)) {
      const [, , , rawId, action] = path.split("/");
      const id = decodeURIComponent(rawId);
      try {
        if (action === "log" && req.method === "GET") return json(res, { log: await agents.log(id) });
        if (action === "diff" && req.method === "GET") return json(res, await agents.diff(id));
        if (req.method !== "POST") return json(res, { error: "method" }, 405);
        if (action === "stop") { await agents.stop(id); return json(res, { ok: true }); }
        if (action === "pr") {
          const { slug } = splitId(id);
          const { url } = await agents.openPr(id, { title: slug.replace(/-/g, " ") });
          return json(res, { ok: true, url });
        }
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

    // Serve UI
    if (path === "/" || path === "/index.html") {
      const html = await readFile(join(__dirname, "..", "ui", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(html);
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    console.error(err);
    json(res, { error: err.message }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  ${PROJECT} / .kanban → ${url}\n`);
  // Auto-open browser (best-effort, silent fail)
  if (!process.env.NO_OPEN) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} ${url}`);
  }
});
