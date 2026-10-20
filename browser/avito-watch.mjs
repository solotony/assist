#!/usr/bin/env node
/* Monitor an Avito search page for new listings and save each one to its own file.
 *
 * Uses the Firefox bridge: reloads a dedicated tab, extracts listing cards,
 * compares item IDs with the saved state and writes new items to
 * data/avito/listings/<date>/<id>.md.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "browser", "bridge", "cli.mjs");
const DEFAULT_URL =
  "https://www.avito.ru/all?cd=1&q=%D0%BD%D0%BE%D0%B6+%D1%81%D1%81%D1%81%D1%80&s=104";

const args = process.argv.slice(2);
const opts = {
  url: DEFAULT_URL,
  interval: 300,
  dataDir: path.join(ROOT, "data", "avito"),
  once: false,
  git: true,
  notify: true,
  verbose: false,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--once") opts.once = true;
  else if (a === "--interval") opts.interval = Math.max(30, Number(args[++i]) || 300);
  else if (a === "--url") opts.url = args[++i];
  else if (a === "--data-dir") opts.dataDir = path.resolve(args[++i]);
  else if (a === "--no-git") opts.git = false;
  else if (a === "--no-notify") opts.notify = false;
  else if (a === "--verbose") opts.verbose = true;
  else if (a === "--help" || a === "-h") {
    console.log(`Usage: avito-watch.mjs [options]

  --once             check once and exit
  --interval <sec>   polling interval, default 300
  --url <url>        Avito search URL
  --data-dir <dir>   where state and listing files live (default data/avito)
  --no-git           do not commit results
  --no-notify        do not show macOS notifications
`);
    process.exit(0);
  }
}

const STATE_PATH = path.join(opts.dataDir, "state.json");
const LATEST_PATH = path.join(opts.dataDir, "latest.json");
const LOG_PATH = path.join(opts.dataDir, "new.log");
const LOCK_PATH = path.join(ROOT, ".assist", "avito-watch.lock");

const EXTRACT_CODE = `Array.from(document.querySelectorAll('[data-marker="item"]')).map((el) => {
  const id = el.getAttribute('data-item-id') || '';
  const titleEl = el.querySelector('[data-marker="item-title"]');
  const priceEl = el.querySelector('[data-marker="item-price"]');
  const locEl = el.querySelector('[data-marker="item-location"]');
  const dateEl = el.querySelector('[data-marker="item-date"]');
  const linkEl = el.querySelector('a[data-marker="item-title"]') || el.querySelector('a[href]');
  const imgEl = el.querySelector('img[itemprop="image"]') || el.querySelector('img');
  const paras = Array.from(el.querySelectorAll('p'))
    .map((p) => (p.innerText || '').trim())
    .filter(Boolean);
  const description = paras.sort((a, b) => b.length - a.length)[0] || '';
  let url = '';
  if (linkEl) {
    try {
      const u = new URL(linkEl.getAttribute('href'), location.origin);
      url = u.origin + u.pathname;
    } catch {}
  }
  return {
    id,
    title: (titleEl && titleEl.innerText || '').trim(),
    price: (priceEl && priceEl.innerText || '').trim(),
    location: (locEl && locEl.innerText || '').trim(),
    published: (dateEl && dateEl.innerText || '').trim(),
    url,
    image: imgEl
      ? (imgEl.currentSrc || imgEl.src || imgEl.getAttribute('data-src') || '')
      : '',
    description,
  };
}).filter((item) => item.id)`;

const log = (...parts) => {
  console.log(`[${new Date().toISOString()}]`, ...parts);
};

const debug = (...parts) => {
  if (opts.verbose) log(...parts);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    state.seen = state.seen || {};
    return state;
  } catch {
    return { seen: {}, tabId: null, baselineDone: false };
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function q(value) {
  return JSON.stringify(String(value ?? ""));
}

function slugDate() {
  return new Date().toLocaleDateString("sv-SE");
}

function listingPath(item) {
  return path.join(opts.dataDir, "listings", slugDate(), `${item.id}.md`);
}

function renderListing(item, firstSeen, baseline) {
  return `---
id: ${q(item.id)}
title: ${q(item.title)}
price: ${q(item.price)}
location: ${q(item.location)}
published: ${q(item.published)}
url: ${q(item.url)}
image: ${q(item.image)}
first_seen: ${q(firstSeen)}
baseline: ${baseline ? "true" : "false"}
---

# ${item.title || "(без названия)"}

- **Цена:** ${item.price || "—"}
- **Город:** ${item.location || "—"}
- **Опубликовано:** ${item.published || "—"}
- **Ссылка:** ${item.url || "—"}

## Описание

${item.description || "_Описание не показано в выдаче._"}
`;
}

function writeListing(item, baseline) {
  const file = listingPath(item);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const firstSeen = new Date().toISOString();
  fs.writeFileSync(file, renderListing(item, firstSeen, baseline));
  return file;
}

function appendLog(items) {
  if (!items.length) return;
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  const lines = items.map((item) =>
    [
      new Date().toISOString(),
      item.id,
      item.price || "",
      item.location || "",
      item.title || "",
      item.url || "",
    ].join("\t"),
  );
  fs.appendFileSync(LOG_PATH, lines.join("\n") + "\n");
}

async function cli(cliArgs, timeout = 60000) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [CLI, ...cliArgs, "--json"],
    { cwd: ROOT, timeout, maxBuffer: 32 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

async function waitForBridge(timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch("http://127.0.0.1:8787/health", { cache: "no-store" });
      const health = await res.json();
      if (health.msSincePoll != null && health.msSincePoll < 60000) return true;
    } catch {
      // bridge is not up yet
    }
    await sleep(1000);
  }
  return false;
}

async function tabExists(tabId) {
  if (!tabId) return false;
  const tabs = await cli(["tabs"]);
  return Array.isArray(tabs) && tabs.some((t) => t.id === tabId);
}

async function ensureTab(state) {
  if (state.tabId && (await tabExists(state.tabId))) {
    debug(`using tab ${state.tabId}`);
    return { tabId: state.tabId, opened: false };
  }
  // Keep the tab active: background tabs are throttled by Firefox and Avito
  // then takes a minute to render the challenge page.
  const opened = await cli(
    ["open", opts.url, "--timeout", "60000"],
    90000,
  );
  state.tabId = opened.tabId;
  log(`opened tab ${state.tabId}`);
  return { tabId: state.tabId, opened: true };
}

function isChallenge(items, pageTitle) {
  if (items.length > 0) return false;
  return /доступ ограничен|проверка безопасности|подтвердите/i.test(pageTitle || "");
}

async function loadPage(state) {
  const { tabId, opened } = await ensureTab(state);

  for (let attempt = 1; attempt <= 3; attempt++) {
    // A freshly opened tab is already loading; reload only on later attempts.
    if (opened && attempt === 1) {
      debug("waiting for the freshly opened tab");
    } else {
      try {
        // Navigate instead of reload: if the tab was reused by the user,
        // this puts it back on the watched search URL.
        await cli(
          ["open", opts.url, "--tab", String(tabId), "--timeout", "60000"],
          90000,
        );
      } catch (err) {
        debug(`navigation failed: ${err.message}`);
      }
    }

    const waited = await cli(
      ["wait", '[data-marker="item"]', "--tab", String(tabId), "--timeout", "40000"],
      100000,
    );
    if (!waited || !waited.found) {
      await sleep(3000);
      continue;
    }

    const page = await cli(
      ["eval", "({title: document.title, count: document.querySelectorAll('[data-marker=\"item\"]').length})", "--tab", String(tabId)],
      30000,
    );
    if (isChallenge([], page.title) && page.count === 0) {
      log(`anti-bot check (attempt ${attempt}), waiting...`);
      await sleep(10000);
      continue;
    }

    const items = await cli(
      ["eval", EXTRACT_CODE, "--tab", String(tabId)],
      60000,
    );

    if (Array.isArray(items) && items.length > 0) return { items, tabId };
    log(`no items on attempt ${attempt}`);
    await sleep(5000);
  }

  throw new Error("could not load listings after 3 attempts (anti-bot?)");
}

function notify(title, message) {
  if (!opts.notify) return;
  const esc = (s) =>
    String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
  try {
    execFile(
      "osascript",
      ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`],
      () => {},
    );
  } catch {
    // notifications are best-effort
  }
}

async function commit(items, baseline) {
  if (!opts.git || !items.length) return;
  const rel = path.relative(ROOT, opts.dataDir);
  if (rel.startsWith("..")) return;
  try {
    await execFileAsync("git", ["add", rel], { cwd: ROOT });
    await execFileAsync("git", ["commit", "-m", `Avito: ${baseline ? "baseline" : "new"} ${items.length} listing(s)`], {
      cwd: ROOT,
      timeout: 30000,
    });
    await execFileAsync("git", ["push"], { cwd: ROOT, timeout: 45000 });
    log(`committed and pushed ${items.length} listing(s)`);
  } catch (err) {
    log(`git commit/push failed: ${err.message.split("\n")[0]}`);
  }
}

async function runOnce(state) {
  const { items } = await loadPage(state);
  const baseline = !state.baselineDone;
  const fresh = items.filter((item) => !state.seen[item.id]);

  if (baseline) {
    for (const item of items) {
      writeListing(item, true);
      state.seen[item.id] = new Date().toISOString();
    }
    state.baselineDone = true;
    log(`baseline: ${items.length} listings saved`);
  } else {
    for (const item of fresh) {
      writeListing(item, false);
      state.seen[item.id] = new Date().toISOString();
    }
    if (fresh.length) {
      appendLog(fresh);
      const first = fresh[0];
      notify(
        `Авито: ${fresh.length} новых`,
        first.title + (first.price ? ` — ${first.price}` : ""),
      );
      log(`new listings: ${fresh.length}`);
      for (const item of fresh) {
        console.log(`  ${item.price}\t${item.location}\t${item.title}\n  ${item.url}`);
      }
    } else {
      log(`no new listings (${items.length} on page)`);
    }
  }

  saveJson(LATEST_PATH, {
    checkedAt: new Date().toISOString(),
    url: opts.url,
    count: items.length,
    items,
  });
  state.lastRun = new Date().toISOString();
  saveJson(STATE_PATH, state);

  if (baseline) await commit(items, true);
  else if (fresh.length) await commit(fresh, false);
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  try {
    const existing = Number(fs.readFileSync(LOCK_PATH, "utf8"));
    if (existing && existing !== process.pid) {
      try {
        process.kill(existing, 0);
        console.error(`[assist] watcher already running (pid ${existing})`);
        process.exit(1);
      } catch {
        // stale lock
      }
    }
  } catch {
    // no lock
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_PATH, "utf8")) === process.pid) {
      fs.unlinkSync(LOCK_PATH);
    }
  } catch {
    // ignore
  }
}

async function main() {
  acquireLock();
  const state = loadState();
  log(
    `watching ${opts.url} every ${opts.interval}s, data in ${path.relative(ROOT, opts.dataDir)}`,
  );

  if (!(await waitForBridge())) {
    log("Firefox bridge is not connected yet; the first check may fail");
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  do {
    try {
      await runOnce(state);
    } catch (err) {
      log(`check failed: ${err.message}`);
      notify("Авито: ошибка мониторинга", err.message);
    }
    if (opts.once || stopping) break;
    await sleep(opts.interval * 1000);
  } while (!stopping);

  releaseLock();
}

main().catch((err) => {
  console.error(err.stack || String(err));
  releaseLock();
  process.exit(1);
});
