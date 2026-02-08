#!/usr/bin/env node

import { createServer } from "node:http";
import { readdir, readFile, rename, writeFile, unlink, mkdir } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";

const COLUMNS = ["todo", "doing", "done"];
const PORT = parseInt(process.env.PORT || "4040", 10);
const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Resolve board: CLI arg > env var > walk up from cwd to find .kanban/
function findBoard() {
  const arg = process.argv[2];
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

// Read board state
async function getBoard() {
  const board = {};
  for (const col of COLUMNS) {
    const dir = join(BOARD, col);
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
    board[col] = [];
    for (const f of files) {
      const raw = await readFile(join(dir, f));
      const { meta, body } = parseFrontmatter(raw);
      board[col].push({
        id: f.replace(/\.md$/, ""),
        file: f,
        body,
        priority: meta.p || null,
      });
    }
  }
  return board;
}

// Simple slug
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  try {
    // API: GET /api/board
    if (path === "/api/board" && req.method === "GET") {
      const b = await getBoard();
      b.project = PROJECT;
      return json(res, b);
    }

    // API: POST /api/cards  { title, body?, priority?, column? }
    if (path === "/api/cards" && req.method === "POST") {
      const data = await body(req);
      const col = data.column || "todo";
      const slug = slugify(data.title || "untitled");
      const file = `${slug}.md`;
      const meta = {};
      if (data.priority) meta.p = data.priority;
      await writeFile(join(BOARD, col, file), toFrontmatter(meta, data.body || data.title || ""));
      return json(res, { ok: true, id: slug }, 201);
    }

    // API: PUT /api/cards/:id/move  { from, to }
    if (path.match(/^\/api\/cards\/[^/]+\/move$/) && req.method === "PUT") {
      const id = decodeURIComponent(path.split("/")[3]);
      const data = await body(req);
      const src = join(BOARD, data.from, `${id}.md`);
      const dst = join(BOARD, data.to, `${id}.md`);
      await rename(src, dst);
      return json(res, { ok: true });
    }

    // API: PUT /api/cards/:id  { body?, priority?, column }
    if (path.match(/^\/api\/cards\/[^/]+$/) && req.method === "PUT") {
      const id = decodeURIComponent(path.split("/")[3]);
      const data = await body(req);
      const file = `${id}.md`;
      // Find which column it's in
      let found = null;
      for (const col of COLUMNS) {
        if (existsSync(join(BOARD, col, file))) { found = col; break; }
      }
      if (!found) return json(res, { error: "not found" }, 404);
      const raw = await readFile(join(BOARD, found, file));
      const parsed = parseFrontmatter(raw);
      const meta = { ...parsed.meta };
      if ("priority" in data) meta.p = data.priority || "";
      const newBody = "body" in data ? data.body : parsed.body;
      await writeFile(join(BOARD, found, file), toFrontmatter(meta, newBody));
      return json(res, { ok: true });
    }

    // API: DELETE /api/cards/:id  { column }
    if (path.match(/^\/api\/cards\/[^/]+$/) && req.method === "DELETE") {
      const id = decodeURIComponent(path.split("/")[3]);
      const file = `${id}.md`;
      for (const col of COLUMNS) {
        const p = join(BOARD, col, file);
        if (existsSync(p)) { await unlink(p); return json(res, { ok: true }); }
      }
      return json(res, { error: "not found" }, 404);
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

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  ${PROJECT} / .kanban → ${url}\n`);
  // Auto-open browser (best-effort, silent fail)
  if (!process.env.NO_OPEN) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} ${url}`);
  }
});
