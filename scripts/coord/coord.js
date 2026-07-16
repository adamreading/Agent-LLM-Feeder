#!/usr/bin/env node
/**
 * coord.js — portable shared task board + message log for N cooperating agents
 * (Claude Code instances / repos). No server, no daemon, no external deps —
 * node stdlib only. An append-only event log folded into a live board.
 *
 * HOW AGENTS "TALK": every agent points at the SAME board directory. Appends
 * from different agents don't clobber each other (append-only), so the board is
 * just a shared folder. Board directory is resolved, in order:
 *   1. $COORD_BOARD_DIR                              (explicit; use for cross-machine)
 *   2. "boardDir" in <thisdir>/coord.config.json     (written by setup-coord)
 *   3. ${XDG_DATA_HOME:-~/.local/share}/coord/board  (portable default)
 *
 * SAME MACHINE (e.g. two repos under one user): the default already resolves to
 * one shared path for both — zero config, they just see each other.
 * DIFFERENT MACHINES / OSes: point $COORD_BOARD_DIR (or config boardDir) at a
 * path both can read/write — a shared mount (NTFS via /mnt/c, NFS), or a synced
 * folder (Syncthing, Dropbox, iCloud). The board is plain JSONL, sync-safe.
 *
 * AGENT IDENTITY (who each append is from), resolved in order:
 *   1. $COORD_AGENT   2. "agent" in coord.config.json   3. <repo-basename>@<host>
 * Deriving <repo>@<host> means many clones on one box (ringer@AJO, feeder@AJO)
 * get distinct identities without any setup.
 *
 * Usage (always via the Bash tool for cross-OS parity):
 *   node scripts/coord/coord.js show [--compact]
 *   node scripts/coord/coord.js add "task title"
 *   node scripts/coord/coord.js claim <id>
 *   node scripts/coord/coord.js status <id> <todo|wip|blocked|done> [note...]
 *   node scripts/coord/coord.js msg "message to peers"
 *   node scripts/coord/coord.js mine
 *   node scripts/coord/coord.js whoami        # print resolved identity + board dir
 *
 * Liveness: a UserPromptSubmit hook runs `show --compact` each turn so every
 * agent sees peers' latest state at its turn boundary (setup-coord installs it).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const SCRIPT_DIR = __dirname;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, "coord.config.json"), "utf8"));
  } catch {
    return {};
  }
}
const CONFIG = readConfig();

function defaultBoardDir() {
  const xdg = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "coord", "board");
}

const BOARD_DIR = process.env.COORD_BOARD_DIR || CONFIG.boardDir || defaultBoardDir();
const EVENTS_PATH = path.join(BOARD_DIR, "events.jsonl");
const LOCK_PATH = path.join(BOARD_DIR, "events.lock");

function deriveAgent() {
  // <repo-basename>@<short-host>, so N clones on one machine stay distinct.
  let repo = "";
  try {
    repo = path.basename(
      cp.execSync("git rev-parse --show-toplevel", { cwd: SCRIPT_DIR, stdio: ["ignore", "pipe", "ignore"] })
        .toString().trim());
  } catch {
    repo = path.basename(path.resolve(SCRIPT_DIR, "..", ".."));
  }
  const host = (os.hostname() || "host").split(".")[0];
  return repo ? `${repo}@${host}` : host;
}
const AGENT = process.env.COORD_AGENT || CONFIG.agent || deriveAgent();

const VALID_STATES = new Set(["todo", "wip", "blocked", "done"]);

function ensureBoardDir() {
  try { fs.mkdirSync(BOARD_DIR, { recursive: true }); } catch {}
}

// ── event log I/O ────────────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }

function readEvents() {
  let raw;
  try { raw = fs.readFileSync(EVENTS_PATH, "utf8"); } catch { return []; }
  const events = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(JSON.parse(t)); } catch { /* skip torn last line */ }
  }
  return events;
}

function appendEvent(event) {
  ensureBoardDir();
  fs.appendFileSync(EVENTS_PATH, JSON.stringify(event) + "\n", "utf8");
}

// Exclusive lock ONLY around id assignment in `add`. Stale locks (>5s) reclaimed.
function withLock(fn) {
  ensureBoardDir();
  const deadline = Date.now() + 4000;
  let fd = null;
  for (;;) {
    try { fd = fs.openSync(LOCK_PATH, "wx"); break; }
    catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const st = fs.statSync(LOCK_PATH);
        if (Date.now() - st.mtimeMs > 5000) { fs.rmSync(LOCK_PATH, { force: true }); continue; }
      } catch {}
      if (Date.now() > deadline) return fn();  // degrade to rare-dup-id, never hang
    }
  }
  try { return fn(); }
  finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.rmSync(LOCK_PATH, { force: true }); } catch {}
  }
}

// ── folding events into a board ──────────────────────────────────────────
function buildBoard(events) {
  const tasks = new Map();
  const messages = [];
  const agents = new Set();
  for (const e of events) {
    if (e.agent) agents.add(e.agent);
    if (e.kind === "add") {
      tasks.set(e.id, { id: e.id, title: e.title || "(untitled)", owner: null,
        state: "todo", createdBy: e.agent || "?", updated: e.ts || "" });
    } else if (e.kind === "claim") {
      const t = tasks.get(e.id);
      if (t) { t.owner = e.agent || t.owner; t.updated = e.ts || t.updated; }
    } else if (e.kind === "status") {
      const t = tasks.get(e.id);
      if (t) {
        if (VALID_STATES.has(e.state)) t.state = e.state;
        if (e.note) t.lastNote = e.note;
        if (e.agent) t.owner = t.owner || e.agent;
        t.updated = e.ts || t.updated;
      }
    } else if (e.kind === "msg") {
      messages.push({ agent: e.agent || "?", text: e.text || "", ts: e.ts || "" });
    }
  }
  return { tasks: [...tasks.values()], messages, agents: [...agents] };
}

function nextId(events) {
  let max = 0;
  for (const e of events)
    if (e.kind === "add" && typeof e.id === "string") {
      const m = e.id.match(/^t(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  return "t" + (max + 1);
}

// ── rendering ──────────────────────────────────────────────────────────
const STATE_TAG = { todo: "TODO", wip: "WIP", blocked: "BLOCKED", done: "DONE" };
function fmtTask(t) {
  const owner = t.owner ? `@${t.owner}` : "unclaimed";
  const note = t.lastNote ? `  — ${t.lastNote}` : "";
  return `  ${t.id}  [${STATE_TAG[t.state] || t.state}] ${owner}  ${t.title}${note}`;
}

function render(board, { compact } = {}) {
  const peers = board.agents.filter((a) => a !== AGENT);
  const lines = [];
  lines.push(`=== COORD BOARD ===  (you: ${AGENT}` +
    (peers.length ? ` · peers: ${peers.join(", ")}` : " · no peers seen yet") + ")");
  const open = board.tasks.filter((t) => t.state !== "done");
  const done = board.tasks.filter((t) => t.state === "done");
  if (!open.length && !done.length) {
    lines.push('  (board empty — `coord add "<task>"` to start)');
  } else {
    if (open.length) { lines.push("Open / in-flight:"); for (const t of open) lines.push(fmtTask(t)); }
    if (!compact && done.length) { lines.push("Done:"); for (const t of done) lines.push(fmtTask(t)); }
    else if (done.length) lines.push(`(${done.length} done — run \`coord show\` for full list)`);
  }
  const msgs = compact ? board.messages.slice(-3) : board.messages.slice(-10);
  if (msgs.length) {
    lines.push("Messages:");
    for (const m of msgs) {
      const when = m.ts ? m.ts.slice(5, 16).replace("T", " ") : "";
      lines.push(`  [${when}] @${m.agent}: ${m.text}`);
    }
  }
  return lines.join("\n");
}

// ── commands ─────────────────────────────────────────────────────────────
function cmdShow(args) { console.log(render(buildBoard(readEvents()), { compact: args.includes("--compact") })); }

function cmdAdd(args) {
  const title = args.join(" ").trim();
  if (!title) { console.error('usage: coord add "<task title>"'); process.exit(1); }
  const id = withLock(() => {
    const events = readEvents();
    const newId = nextId(events);
    appendEvent({ ts: nowIso(), agent: AGENT, kind: "add", id: newId, title });
    return newId;
  });
  console.log(`added ${id}: ${title}`);
}

function cmdClaim(args) {
  const id = (args[0] || "").trim();
  if (!id) { console.error("usage: coord claim <id>"); process.exit(1); }
  appendEvent({ ts: nowIso(), agent: AGENT, kind: "claim", id });
  console.log(`@${AGENT} claimed ${id}`);
}

function cmdStatus(args) {
  const id = (args[0] || "").trim();
  const state = (args[1] || "").trim().toLowerCase();
  const note = args.slice(2).join(" ").trim();
  if (!id || !VALID_STATES.has(state)) {
    console.error("usage: coord status <id> <todo|wip|blocked|done> [note...]"); process.exit(1);
  }
  appendEvent({ ts: nowIso(), agent: AGENT, kind: "status", id, state, note: note || undefined });
  console.log(`${id} -> ${state}${note ? ` (${note})` : ""}`);
}

function cmdMsg(args) {
  const text = args.join(" ").trim();
  if (!text) { console.error('usage: coord msg "<message>"'); process.exit(1); }
  appendEvent({ ts: nowIso(), agent: AGENT, kind: "msg", text });
  console.log(`@${AGENT}: ${text}`);
}

function cmdMine() {
  const board = buildBoard(readEvents());
  const mine = board.tasks.filter((t) => t.owner === AGENT && t.state !== "done");
  if (!mine.length) { console.log(`(no open tasks owned by @${AGENT})`); return; }
  console.log(`Tasks owned by @${AGENT}:`);
  for (const t of mine) console.log(fmtTask(t));
}

function cmdWhoami() {
  console.log(`agent    : ${AGENT}`);
  console.log(`board dir: ${BOARD_DIR}`);
  console.log(`events   : ${EVENTS_PATH}${fs.existsSync(EVENTS_PATH) ? "" : "  (not created yet)"}`);
  const src = process.env.COORD_BOARD_DIR ? "env COORD_BOARD_DIR"
    : CONFIG.boardDir ? "coord.config.json" : "default (~/.local/share)";
  console.log(`resolved via: ${src}`);
}

// ── dispatch ─────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
switch ((cmd || "show").toLowerCase()) {
  case "show": cmdShow(rest); break;
  case "add": cmdAdd(rest); break;
  case "claim": cmdClaim(rest); break;
  case "status": cmdStatus(rest); break;
  case "msg": cmdMsg(rest); break;
  case "mine": cmdMine(); break;
  case "whoami": cmdWhoami(); break;
  default:
    console.error([
      "coord — portable shared board for N cooperating agents",
      "commands:",
      "  show [--compact]", '  add "<title>"', "  claim <id>",
      "  status <id> <todo|wip|blocked|done> [note...]", '  msg "<text>"',
      "  mine", "  whoami",
    ].join("\n"));
    process.exit(1);
}
