#!/usr/bin/env node
/* Assist Bridge CLI — send a command to Firefox through the local bridge. */

import fs from "node:fs";
import path from "node:path";

const BASE = `http://127.0.0.1:${process.env.ASSIST_PORT || 8787}`;
const DEFAULT_TIMEOUT = 90000;

const argv = process.argv.slice(2);
const opts = { active: true, json: false, timeout: DEFAULT_TIMEOUT };
const pos = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--tab") opts.tabId = Number(argv[++i]);
  else if (arg === "--timeout") opts.timeout = Number(argv[++i]);
  else if (arg === "--selector") opts.selector = argv[++i];
  else if (arg === "--out") opts.out = argv[++i];
  else if (arg === "--name") opts.name = argv[++i];
  else if (arg === "--background") opts.active = false;
  else if (arg === "--json") opts.json = true;
  else pos.push(arg);
}

const action = pos[0];

function fail(message) {
  console.error(message);
  process.exit(2);
}

if (!action) {
  console.error(`Usage: cli.mjs <action> [args] [flags]

Actions:
  open <url>                 open URL in a new tab (or --tab to reuse)
  tabs                       list open tabs
  text [selector]            readable text of page or element
  html [selector]            outer HTML of page or element
  links [selector]           links on the page (default a[href])
  attr <selector> <name>     attribute value
  click <selector>           click an element
  type <selector> <text>     fill an input/textarea
  press <key> [selector]     dispatch key events (default Enter)
  scroll <y> [x]             scroll the page
  wait <selector>            wait until an element exists
  sleep <ms>                 wait
  eval <js>                  run JS in the page (isolated world)
  screenshot [path]          save a PNG of the visible tab
  url                        current URL and title
  reload [--tab id]          reload
  back / forward             history navigation
  close [--tab id]           close tab
  stop                       stop the bridge server

Flags:
  --tab <id>                 target tab (default: active tab)
  --timeout <ms>             command timeout
  --background               open URL in background
  --json                     print raw JSON
`);
  process.exit(2);
}

function buildCommand() {
  const rest = pos.slice(1);
  const cmd = { action };
  if (opts.tabId) cmd.tabId = opts.tabId;

  switch (action) {
    case "open":
      if (!rest[0]) fail("open: URL is required");
      cmd.url = rest[0];
      cmd.active = opts.active;
      cmd.timeout = opts.timeout;
      break;
    case "text":
    case "html":
    case "links":
      cmd.selector = opts.selector || rest[0] || undefined;
      break;
    case "attr":
      if (rest.length < 2) fail("attr: selector and name are required");
      cmd.selector = rest[0];
      cmd.name = rest[1];
      break;
    case "click":
    case "wait":
      if (!rest[0]) fail(`${action}: selector is required`);
      cmd.selector = rest[0];
      if (action === "wait") cmd.timeout = opts.timeout;
      break;
    case "type":
      if (!rest[0]) fail("type: selector is required");
      cmd.selector = rest[0];
      cmd.text = rest.slice(1).join(" ");
      break;
    case "press":
      cmd.key = rest[0] || "Enter";
      cmd.selector = rest[1];
      break;
    case "scroll":
      cmd.y = Number(rest[0] || 0);
      cmd.x = Number(rest[1] || 0);
      break;
    case "sleep":
      cmd.ms = Number(rest[0] || 1000);
      break;
    case "eval":
      if (!rest.length) fail("eval: code is required");
      cmd.code = rest.join(" ");
      break;
    case "screenshot":
      cmd.out = opts.out || rest[0];
      break;
    case "tabs":
    case "url":
    case "reload":
    case "back":
    case "forward":
    case "close":
    case "stop":
      break;
    default:
      fail(`unknown action: ${action}`);
  }
  return cmd;
}

let token = null;

async function ensureToken() {
  if (token) return;
  const res = await fetch(`${BASE}/handshake`, { cache: "no-store" });
  if (!res.ok) throw new Error(`handshake failed: ${res.status}`);
  const data = await res.json();
  token = data.token;
}

async function request(pathname, options = {}, retried = false) {
  await ensureToken();
  const headers = { ...(options.headers || {}), "X-Assist-Token": token };
  const res = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers,
    cache: "no-store",
  });
  if (res.status === 401 && !retried) {
    token = null;
    await ensureToken();
    return request(pathname, options, true);
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { res, data };
}

async function main() {
  if (action === "stop") {
    try {
      await request("/shutdown", { method: "POST" });
      console.log("bridge stopped");
    } catch {
      console.log("bridge is not running");
    }
    return;
  }

  const cmd = buildCommand();

  let enqueued;
  try {
    enqueued = await request("/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
  } catch (err) {
    fail(`bridge is not running: ${err.message}\nStart it with: ./scripts/ff.sh`);
  }

  if (!enqueued.res.ok || !enqueued.data?.id) {
    fail(`enqueue failed: ${JSON.stringify(enqueued.data)}`);
  }

  const id = enqueued.data.id;
  const deadline = Date.now() + opts.timeout + 15000;

  let result = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 120));
    const { res, data } = await request(`/result?id=${encodeURIComponent(id)}`);
    if (res.status === 200) {
      result = data;
      break;
    }
    if (res.status === 404) fail("command was lost by the bridge");
  }

  if (!result) fail(`timeout waiting for ${action}`);
  if (!result.ok) fail(result.error || "command failed");

  const data = result.data;

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  switch (action) {
    case "text":
      if (data && data.text !== undefined) console.log(data.text);
      else console.log(JSON.stringify(data, null, 2));
      break;
    case "html":
      if (data && data.html !== undefined) console.log(data.html);
      else console.log(JSON.stringify(data, null, 2));
      break;
    case "screenshot": {
      if (!data?.dataUrl) fail("no screenshot data");
      const base64 = data.dataUrl.replace(/^data:image\/png;base64,/, "");
      const out = path.resolve(
        opts.out ||
          pos[1] ||
          path.join("browser", "shots", `shot-${Date.now()}.png`),
      );
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(base64, "base64"));
      console.log(out);
      break;
    }
    case "tabs":
      for (const tab of data) {
        console.log(
          `${tab.active ? "*" : " "} ${String(tab.id).padStart(4)}  ${tab.title || "(no title)"}\n        ${tab.url}`,
        );
      }
      break;
    case "open":
      console.log(
        `#${data.tabId} ${data.tab?.url || cmd.url}\n${data.tab?.title || ""}`.trim(),
      );
      break;
    case "url":
      console.log(`${data.url}\n${data.title}`);
      break;
    default:
      console.log(JSON.stringify(data, null, 2));
  }
}

main().catch((err) => fail(err.stack || String(err)));
