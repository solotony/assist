#!/usr/bin/env node
/* Assist Bridge server — local command queue between the CLI and the Firefox extension.
 * Binds to 127.0.0.1 only. No CORS headers on purpose: web pages must not be able to use it.
 */

import http from "node:http";
import crypto from "node:crypto";

const HOST = "127.0.0.1";
const PORT = Number(process.env.ASSIST_PORT || 8787);
const MAX_BODY = 50 * 1024 * 1024;
const RESULT_TTL_MS = 10 * 60 * 1000;

const token = crypto.randomBytes(24).toString("hex");
const queue = [];
const results = new Map();
let inflight = null;
let lastPoll = 0;
let lastResult = 0;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function pruneResults() {
  const cutoff = Date.now() - RESULT_TTL_MS;
  for (const [id, entry] of results) {
    if (entry.finishedAt < cutoff) results.delete(id);
  }
}

function isAllowedOrigin(origin) {
  if (!origin) return true; // CLI / curl / extension background
  return origin.startsWith("moz-extension://");
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const origin = req.headers.origin;

  if (!isAllowedOrigin(origin)) {
    return json(res, 403, { error: "forbidden origin" });
  }

  if (req.method === "GET" && url.pathname === "/handshake") {
    return json(res, 200, { token, pid: process.pid, port: PORT });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, {
      ok: true,
      pid: process.pid,
      port: PORT,
      queued: queue.length,
      inflight: inflight ? { id: inflight.id, action: inflight.action } : null,
      msSincePoll: lastPoll ? Date.now() - lastPoll : null,
      msSinceResult: lastResult ? Date.now() - lastResult : null,
    });
  }

  if (req.headers["x-assist-token"] !== token) {
    return json(res, 401, { error: "unauthorized" });
  }

  if (req.method === "GET" && url.pathname === "/next") {
    pruneResults();
    if (!queue.length) {
      lastPoll = Date.now();
      res.writeHead(204, { "Cache-Control": "no-store" });
      return res.end();
    }
    if (inflight) {
      // Recover if the extension got stuck on a page that never responds.
      if (Date.now() - inflight.startedAt > 120000) {
        results.set(inflight.id, {
          id: inflight.id,
          ok: false,
          error: "command timed out inside the browser",
          finishedAt: Date.now(),
        });
        inflight = null;
      } else {
        // The extension is still executing the previous command.
        return json(res, 409, { error: "command in flight", id: inflight.id });
      }
    }
    const cmd = queue.shift();
    inflight = { id: cmd.id, action: cmd.action, startedAt: Date.now() };
    lastPoll = Date.now();
    return json(res, 200, cmd);
  }

  if (req.method === "POST" && url.pathname === "/result") {
    const raw = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    if (!payload || !payload.id) {
      return json(res, 400, { error: "missing id" });
    }
    results.set(payload.id, { ...payload, finishedAt: Date.now() });
    if (inflight && inflight.id === payload.id) inflight = null;
    lastResult = Date.now();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/enqueue") {
    const raw = await readBody(req);
    let cmd;
    try {
      cmd = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    if (!cmd || typeof cmd !== "object" || !cmd.action) {
      return json(res, 400, { error: "action is required" });
    }
    const id = crypto.randomUUID();
    const entry = { id, createdAt: Date.now(), ...cmd };
    queue.push(entry);
    return json(res, 200, { id, command: entry });
  }

  if (req.method === "GET" && url.pathname === "/result") {
    const id = url.searchParams.get("id");
    if (!id) return json(res, 400, { error: "id is required" });
    const entry = results.get(id);
    if (!entry) {
      if (queue.some((c) => c.id === id) || (inflight && inflight.id === id)) {
        return json(res, 202, { pending: true });
      }
      return json(res, 404, { error: "unknown id" });
    }
    return json(res, 200, entry);
  }

  if (req.method === "POST" && url.pathname === "/shutdown") {
    json(res, 200, { ok: true, stopping: true });
    setTimeout(() => process.exit(0), 50);
    return;
  }

  return json(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { error: String(err) });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[assist] bridge listening on http://${HOST}:${PORT} (pid ${process.pid})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[assist] ${signal}, stopping`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
