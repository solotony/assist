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
import { isRelevant } from "./avito-filter.mjs";

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
  clean: false,
  dryRun: false,
  backfillImages: false,
  localOnly: false,
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
  else if (a === "--clean") opts.clean = true;
  else if (a === "--backfill-images") opts.backfillImages = true;
  else if (a === "--local-only") opts.localOnly = true;
  else if (a === "--dry-run") opts.dryRun = true;
  else if (a === "--help" || a === "-h") {
    console.log(`Usage: avito-watch.mjs [options]

  --once             check once and exit
  --interval <sec>   polling interval, default 300
  --url <url>        Avito search URL
  --data-dir <dir>   where state and listing files live (default data/avito)
  --no-git           do not commit results
  --no-notify        do not show macOS notifications
  --clean            remove saved listings that do not match the filter
  --backfill-images  download photos for saved listings that have none
  --local-only       with --backfill-images: only refresh links to existing photos
  --dry-run          with --clean: only show what would be removed
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
  let image = '';
  if (imgEl) {
    image = imgEl.currentSrc || imgEl.src || imgEl.getAttribute('data-src') || '';
    if (!image) {
      const srcset = imgEl.getAttribute('srcset') || '';
      const candidates = srcset.split(',').map((s) => s.trim().split(/\\s+/)[0]).filter(Boolean);
      if (candidates.length) image = candidates[candidates.length - 1];
    }
    if (!image) {
      const bg = getComputedStyle(imgEl).backgroundImage || '';
      const m = bg.match(/url\\(["']?(.*?)["']?\\)/);
      if (m) image = m[1];
    }
    if (image) {
      try { image = new URL(image, location.origin).href; } catch {}
    }
  }
  // Avito keeps the card gallery URLs in data-marker attributes. This works
  // even for cards whose <img> has not been lazy-loaded yet.
  const images = Array.from(
    new Set(
      Array.from(el.querySelectorAll('[data-marker^="slider-image/image-"]'))
        .map((node) => node.getAttribute('data-marker').replace('slider-image/image-', ''))
        .filter((src) => src && !src.startsWith('data:'))
        .map((src) => {
          try { return new URL(src, location.origin).href; } catch { return src; }
        }),
    ),
  );
  if (images.length) image = images[0];
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
    image,
    images,
    description,
  };
}).filter((item) => item.id)`;

const LISTING_IMAGE_CODE = `(() => {
  const imgs = Array.from(document.querySelectorAll('img')).filter((i) => {
    const w = i.naturalWidth || 0;
    const h = i.naturalHeight || 0;
    return w >= 300 && h >= 200 && !/logo|avatar|seller/i.test(String(i.className));
  });
  const withAlt = imgs.find((i) => (i.alt || '').trim());
  const img = withAlt || imgs.sort((a, b) => (b.naturalWidth * b.naturalHeight) - (a.naturalWidth * a.naturalHeight))[0];
  if (!img) return '';
  let src = img.currentSrc || img.src || '';
  if (!src) {
    const srcset = img.getAttribute('srcset') || '';
    const candidates = srcset.split(',').map((s) => s.trim().split(/\\s+/)[0]).filter(Boolean);
    if (candidates.length) src = candidates[candidates.length - 1];
  }
  if (src) {
    try { src = new URL(src, location.origin).href; } catch {}
  }
  return src;
})()`;

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

function listingImageDir(item) {
  return path.join(path.dirname(listingPath(item)), item.id);
}

async function fetchListingImage(item, tabId) {
  if (!item.url || !tabId) return "";
  try {
    await cli(["open", item.url, "--tab", String(tabId), "--timeout", "60000"], 90000);
    await cli(["wait", "img", "--tab", String(tabId), "--timeout", "30000"], 60000);
    await sleep(1000);
    const image = await cli(["eval", LISTING_IMAGE_CODE, "--tab", String(tabId)], 60000);
    return typeof image === "string" ? image : "";
  } catch (err) {
    log(`listing image failed for ${item.id}: ${err.message}`);
    return "";
  }
}

async function downloadImage(url, destBase) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Referer: "https://www.avito.ru/",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!type.startsWith("image/")) throw new Error(`not an image: ${type || "unknown"}`);
    const ext =
      type === "image/png" ? "png" : type === "image/webp" ? "webp" : type === "image/avif" ? "avif" : "jpg";
    const file = `${destBase}.${ext}`;
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return path.basename(file);
  } catch (err) {
    log(`image download failed: ${err.message}`);
    return null;
  }
}

async function downloadImages(item) {
  const urls = (item.images && item.images.length ? item.images : [item.image]).filter(
    (url) => url && !url.startsWith("data:"),
  );
  if (!urls.length) return [];
  const dir = listingImageDir(item);
  fs.mkdirSync(dir, { recursive: true });
  const names = [];
  for (const [index, url] of urls.entries()) {
    const name = await downloadImage(url, path.join(dir, String(index + 1)));
    if (name) names.push(name);
  }
  return names;
}

function renderPhoto(item) {
  if (item.localImages && item.localImages.length) {
    return `## Фото\n\n${item.localImages
      .map((name, index) => `![Фото ${index + 1}](${item.id}/${name})`)
      .join("\n\n")}\n`;
  }
  if (item.image) return `## Фото\n\n![Фото](${item.image})\n`;
  return "";
}

function renderListing(item, firstSeen, baseline) {
  const photo = renderPhoto(item);
  return `---
id: ${q(item.id)}
title: ${q(item.title)}
price: ${q(item.price)}
location: ${q(item.location)}
published: ${q(item.published)}
url: ${q(item.url)}
image: ${q(item.image)}
image_local: ${q(item.localImages && item.localImages[0] ? `${item.id}/${item.localImages[0]}` : "")}
first_seen: ${q(firstSeen)}
baseline: ${baseline ? "true" : "false"}
---

# ${item.title || "(без названия)"}

- **Цена:** ${item.price || "—"}
- **Город:** ${item.location || "—"}
- **Опубликовано:** ${item.published || "—"}
- **Ссылка:** ${item.url || "—"}

${photo ? `${photo}\n` : ""}## Описание

${item.description || "_Описание не показано в выдаче._"}
`;
}

async function writeListing(item, baseline, tabId) {
  const file = listingPath(item);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const firstSeen = new Date().toISOString();

  if (!baseline && tabId && !(item.images && item.images.length)) {
    // Fallback for the rare card without gallery data: open the listing page.
    const remote = await fetchListingImage(item, tabId);
    if (remote) {
      item.image = remote;
      item.images = [remote];
      item._visitedListing = true;
    }
  }
  if (!item.image && item.images && item.images.length) item.image = item.images[0];

  item.localImages = await downloadImages(item);
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

    // Give lazy-loaded card images a moment to get their URLs.
    await sleep(1000);

    const page = await cli(
      ["eval", "({title: document.title, count: document.querySelectorAll('[data-marker=\"item\"]').length})", "--tab", String(tabId)],
      60000,
    );
    if (isChallenge([], page.title) && page.count === 0) {
      log(`anti-bot check (attempt ${attempt}), waiting...`);
      await sleep(10000);
      continue;
    }

    const items = await cli(
      ["eval", EXTRACT_CODE, "--tab", String(tabId)],
      90000,
    );

    if (Array.isArray(items) && items.length > 0) return { items, tabId };
    log(`no items on attempt ${attempt}`);
    await sleep(5000);
  }

  throw new Error("could not load listings after 3 attempts (anti-bot?)");
}

async function notify(title, message, url) {
  if (!opts.notify) return;
  // A native dialog instead of osascript's notification: clicking "Show"
  // in Notification Center used to launch Script Editor. Here "Открыть"
  // opens the listing in Firefox directly.
  dialogNotify(title, message, url);
}

function dialogNotify(title, message, url) {
  const esc = (s) =>
    String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
  const script = url
    ? `try
         display dialog "${esc(title)}\\n\\n${esc(message)}" buttons {"Закрыть", "Открыть"} default button "Открыть" with title "Авито" with icon note giving up after 120
         if button returned of result is "Открыть" then do shell script "open -a Firefox " & quoted form of "${esc(url)}"
       end try`
    : `try
         display dialog "${esc(title)}\\n\\n${esc(message)}" buttons {"OK"} default button "OK" with title "Авито" with icon caution giving up after 120
       end try`;
  try {
    execFile("osascript", ["-e", script], () => {});
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
  const { items: allItems, tabId } = await loadPage(state);
  const items = allItems.filter(isRelevant);
  const baseline = !state.baselineDone;
  const fresh = items.filter((item) => !state.seen[item.id]);

  if (baseline) {
    for (const item of items) {
      await writeListing(item, true);
      state.seen[item.id] = new Date().toISOString();
    }
    state.baselineDone = true;
    log(`baseline: ${items.length} listings saved`);
  } else {
    for (const item of fresh) {
      await writeListing(item, false, tabId);
      state.seen[item.id] = new Date().toISOString();
    }
    if (fresh.length) {
      // A card without gallery data may have sent the tab to a listing page.
      if (fresh.some((item) => item._visitedListing)) {
        try {
          await cli(["open", opts.url, "--tab", String(tabId), "--timeout", "60000"], 90000);
        } catch (err) {
          debug(`return to search failed: ${err.message}`);
        }
      }
      appendLog(fresh);
      const first = fresh[0];
      await notify(
        `Авито: ${fresh.length} новых`,
        first.title + (first.price ? ` — ${first.price}` : ""),
        first.url,
      );
      log(`new listings: ${fresh.length}`);
      for (const item of fresh) {
        console.log(`  ${item.price}\t${item.location}\t${item.title}\n  ${item.url}`);
      }
    } else {
      log(`no new listings (${items.length} relevant of ${allItems.length} on page)`);
    }
  }

  saveJson(LATEST_PATH, {
    checkedAt: new Date().toISOString(),
    url: opts.url,
    count: items.length,
    rawCount: allItems.length,
    items,
  });
  state.lastRun = new Date().toISOString();
  saveJson(STATE_PATH, state);

  if (baseline) await commit(items, true);
  else if (fresh.length) await commit(fresh, false);
}

function cleanListings(dryRun) {
  const listingsDir = path.join(opts.dataDir, "listings");
  const keptIds = new Set();
  const removedFiles = [];
  let kept = 0;
  let removed = 0;

  if (fs.existsSync(listingsDir)) {
    for (const dateName of fs.readdirSync(listingsDir)) {
      const dateDir = path.join(listingsDir, dateName);
      if (!fs.statSync(dateDir).isDirectory()) continue;
      for (const file of fs.readdirSync(dateDir)) {
        if (!file.endsWith(".md")) continue;
        const full = path.join(dateDir, file);
        const raw = fs.readFileSync(full, "utf8");
        const id = (raw.match(/^id:\s*"?([^"\n]+)"?/m) || [])[1] || path.basename(file, ".md");
        const title = (raw.match(/^title:\s*"(.*)"\s*$/m) || [])[1] || "";
        const description = (raw.split("## Описание")[1] || "").trim();
        if (isRelevant({ title, description })) {
          kept++;
          keptIds.add(id);
        } else {
          removed++;
          removedFiles.push(path.relative(ROOT, full));
          if (!dryRun) {
            fs.unlinkSync(full);
            const imageDir = path.join(dateDir, id);
            if (fs.existsSync(imageDir)) fs.rmSync(imageDir, { recursive: true, force: true });
          }
        }
      }
      if (!dryRun && fs.readdirSync(dateDir).length === 0) fs.rmdirSync(dateDir);
    }
  }

  let logRemoved = 0;
  if (fs.existsSync(LOG_PATH)) {
    const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");
    const keptLines = lines.filter((line) => {
      if (!line.trim()) return false;
      const id = line.split("\t")[1];
      const keep = !id || keptIds.has(id);
      if (!keep) logRemoved++;
      return keep;
    });
    if (!dryRun) {
      fs.writeFileSync(LOG_PATH, keptLines.length ? `${keptLines.join("\n")}\n` : "");
    }
  }

  return { kept, removed, logRemoved, removedFiles };
}

function frontMatterField(raw, name) {
  const match = raw.match(new RegExp(`^${name}:\\s*(.*)$`, "m"));
  if (!match) return "";
  const value = match[1].trim();
  if (!value.startsWith('"')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value.replace(/^"|"$/g, "");
  }
}

function localImageFiles(file, id) {
  const dir = path.join(path.dirname(file), id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => /^\d+\.(jpe?g|png|webp|avif)$/i.test(name))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
}

function findLocalImage(file, id) {
  return localImageFiles(file, id)[0] || "";
}

function updateListingImage(file, id, remote) {
  const names = localImageFiles(file, id);
  if (!names.length) return false;

  let raw = fs.readFileSync(file, "utf8");
  const firstRel = `${id}/${names[0]}`;

  if (remote) raw = raw.replace(/^image:.*$/m, `image: ${q(remote)}`);
  if (/^image_local:.*$/m.test(raw)) {
    raw = raw.replace(/^image_local:.*$/m, `image_local: ${q(firstRel)}`);
  } else {
    raw = raw.replace(/^(image:.*)$/m, `$1\nimage_local: ${q(firstRel)}`);
  }

  const section = `## Фото\n\n${names
    .map((name, index) => `![Фото ${index + 1}](${id}/${name})`)
    .join("\n\n")}\n\n`;

  const heading = raw.search(/^## Фото\s*$/m);
  if (heading >= 0) {
    const next = raw.indexOf("\n## ", heading + 1);
    const end = next >= 0 ? next + 1 : raw.length;
    raw = raw.slice(0, heading) + section + raw.slice(end);
  } else if (/^## Описание\s*$/m.test(raw)) {
    raw = raw.replace(/^## Описание\s*$/m, `${section}## Описание`);
  } else {
    raw = `${raw.trimEnd()}\n\n${section}`;
  }

  fs.writeFileSync(file, raw);
  return true;
}

function findListingFiles() {
  const listingsDir = path.join(opts.dataDir, "listings");
  const files = [];
  if (!fs.existsSync(listingsDir)) return files;
  for (const dateName of fs.readdirSync(listingsDir)) {
    const dateDir = path.join(listingsDir, dateName);
    if (!fs.statSync(dateDir).isDirectory()) continue;
    for (const name of fs.readdirSync(dateDir)) {
      if (name.endsWith(".md")) files.push(path.join(dateDir, name));
    }
  }
  return files.sort();
}

async function backfillImages() {
  const files = findListingFiles();
  if (!files.length) {
    log("no saved listings to backfill");
    return;
  }
  if (!(await waitForBridge())) throw new Error("Firefox bridge is not running");

  let tabId = null;
  let downloaded = 0;
  let existing = 0;
  let failed = 0;

  try {
    for (const file of files) {
      const raw = fs.readFileSync(file, "utf8");
      const id = frontMatterField(raw, "id") || path.basename(file, ".md");
      const url = frontMatterField(raw, "url");
      const remote = frontMatterField(raw, "image");
      const local = findLocalImage(file, id);

      if (local) {
        updateListingImage(file, id, remote);
        existing++;
        continue;
      }
      if (opts.localOnly) continue;
      if (!url) {
        failed++;
        log(`image skipped for ${id}: no listing URL`);
        continue;
      }

      // Opening many listing pages in a row can trigger Avito's IP check.
      await sleep(3000);

      if (!tabId) {
        const opened = await cli(["open", url, "--timeout", "60000"], 90000);
        tabId = opened.tabId;
      }
      const image = await fetchListingImage({ id, url }, tabId);
      if (!image) {
        failed++;
        continue;
      }

      const dir = path.join(path.dirname(file), id);
      fs.mkdirSync(dir, { recursive: true });
      const name = await downloadImage(image, path.join(dir, "1"));
      if (!name) {
        failed++;
        continue;
      }

      updateListingImage(file, id, image);
      downloaded++;
      log(`image saved for ${id}: ${name}`);
    }
  } finally {
    if (tabId) {
      try {
        await cli(["close", "--tab", String(tabId)], 30000);
      } catch {
        // tab may already be gone
      }
    }
  }

  log(`images: ${downloaded} downloaded, ${existing} already present, ${failed} failed`);
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

  if (opts.clean) {
    const result = cleanListings(opts.dryRun);
    if (opts.dryRun) {
      for (const file of result.removedFiles) log(`would remove ${file}`);
    }
    log(
      `${opts.dryRun ? "would remove" : "removed"} ${result.removed} listing(s), ` +
        `kept ${result.kept}, log lines removed ${result.logRemoved}`,
    );
    releaseLock();
    return;
  }

  if (opts.backfillImages) {
    await backfillImages();
    releaseLock();
    return;
  }

  const state = loadState();
  log(
    `watching ${opts.url} every ${opts.interval}s, data in ${path.relative(ROOT, opts.dataDir)}`,
  );

  if (!(await waitForBridge())) {
    log("Firefox bridge is not connected yet; the first check may fail");
  }

  let stopping = false;
  let bridgeDown = false;
  let lastErrorNotify = 0;
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
      if (bridgeDown) {
        bridgeDown = false;
        log("bridge is back; monitoring resumed");
      }
    } catch (err) {
      const isBridgeDown = /bridge is not running|fetch failed/i.test(err.message);
      if (isBridgeDown) {
        // Firefox was closed: warn and log once, then stay quiet until it is back.
        if (!bridgeDown) {
          bridgeDown = true;
          log(`check failed: ${err.message}`);
          await notify(
            "Авито: мониторинг остановлен",
            "Firefox закрыт или мост недоступен. Запусти ./scripts/ff.sh",
          );
        }
      } else {
        log(`check failed: ${err.message}`);
        if (Date.now() - lastErrorNotify > 60 * 60 * 1000) {
          // Other errors are rare; keep them at most once an hour.
          lastErrorNotify = Date.now();
          await notify("Авито: ошибка мониторинга", err.message);
        }
      }
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
