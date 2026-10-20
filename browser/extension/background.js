/* Assist Bridge — Firefox background script.
 * Polls a local server for commands and executes them with WebExtension APIs.
 */

const BASE = "http://127.0.0.1:8787";
const POLL_IDLE_MS = 250;

let token = null;
let stopped = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function handshake() {
  const res = await fetch(`${BASE}/handshake`, { cache: "no-store" });
  if (!res.ok) throw new Error(`handshake failed: ${res.status}`);
  const data = await res.json();
  token = data.token;
}

async function api(path, options = {}) {
  if (!token) await handshake();
  const headers = Object.assign({}, options.headers || {}, {
    "X-Assist-Token": token,
  });
  const res = await fetch(`${BASE}${path}`, { ...options, headers, cache: "no-store" });
  if (res.status === 401) {
    await handshake();
    return api(path, options);
  }
  return res;
}

async function resolveTabId(tabId) {
  if (tabId) return tabId;
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length) throw new Error("no active tab");
  return tabs[0].id;
}

async function tabInfo(tabId) {
  const tab = await browser.tabs.get(tabId);
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    status: tab.status,
    active: tab.active,
    windowId: tab.windowId,
  };
}

function waitForLoad(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = async (why) => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      const info = await tabInfo(tabId).catch(() => null);
      resolve({ why, tab: info });
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") finish("complete");
    };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish("timeout"), timeout);
    browser.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === "complete") finish("already-complete");
      })
      .catch(() => {});
  });
}

async function runInTab(tabId, code) {
  const id = await resolveTabId(tabId);
  const results = await browser.tabs.executeScript(id, {
    code,
    runAt: "document_idle",
  });
  return results ? results[0] : null;
}

async function openTab(cmd) {
  const { url, active = true, tabId, timeout = 30000 } = cmd;
  if (!url) throw new Error("open: url is required");
  let id = tabId;
  if (id) {
    await browser.tabs.update(id, { url, active });
  } else {
    let tab;
    try {
      tab = await browser.tabs.create({ url, active });
    } catch (err) {
      // Firefox refuses tabs.create when no browser window exists.
      const win = await browser.windows.create({ url, focused: active !== false });
      tab = win.tabs[0];
    }
    id = tab.id;
  }
  const loaded = await waitForLoad(id, timeout);
  return { tabId: id, ...loaded };
}

async function waitForSelector(tabId, selector, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const found = await runInTab(
      tabId,
      `!!document.querySelector(${JSON.stringify(selector)})`,
    );
    if (found) return { found: true, waitedMs: Date.now() - start };
    await sleep(300);
  }
  return { found: false, waitedMs: Date.now() - start };
}

async function exec(cmd) {
  const id = cmd.tabId;
  switch (cmd.action) {
    case "open":
      return openTab(cmd);

    case "tabs": {
      const tabs = await browser.tabs.query({});
      return tabs
        .map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          pinned: t.pinned,
          windowId: t.windowId,
        }))
        .sort((a, b) => a.id - b.id);
    }

    case "close": {
      const tabId = await resolveTabId(id);
      await browser.tabs.remove(tabId);
      return { closed: tabId };
    }

    case "reload": {
      const tabId = await resolveTabId(id);
      await browser.tabs.reload(tabId);
      return { reloaded: tabId };
    }

    case "back": {
      const tabId = await resolveTabId(id);
      await browser.tabs.goBack(tabId);
      return { tabId };
    }

    case "forward": {
      const tabId = await resolveTabId(id);
      await browser.tabs.goForward(tabId);
      return { tabId };
    }

    case "url": {
      const tabId = await resolveTabId(id);
      return runInTab(
        tabId,
        `({ url: location.href, title: document.title })`,
      );
    }

    case "text": {
      const sel = cmd.selector || null;
      return runInTab(
        id,
        `(() => {
          const el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : "document.body"};
          if (!el) return { found: false, url: location.href, title: document.title };
          const text = (el.innerText || el.textContent || "").trim();
          return {
            found: true,
            url: location.href,
            title: document.title,
            length: text.length,
            text: text.slice(0, 200000)
          };
        })()`,
      );
    }

    case "html": {
      const sel = cmd.selector || null;
      return runInTab(
        id,
        `(() => {
          const el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : "document.body"};
          if (!el) return { found: false, url: location.href, title: document.title };
          return {
            found: true,
            url: location.href,
            title: document.title,
            html: el.outerHTML.slice(0, 500000)
          };
        })()`,
      );
    }

    case "links": {
      return runInTab(
        id,
        `(() => {
          const sel = ${JSON.stringify(cmd.selector || "a[href]")};
          return Array.from(document.querySelectorAll(sel)).slice(0, 1000).map((a) => ({
            text: (a.innerText || a.textContent || "").trim().slice(0, 300),
            href: a.href
          }));
        })()`,
      );
    }

    case "attr": {
      return runInTab(
        id,
        `(() => {
          const el = document.querySelector(${JSON.stringify(cmd.selector)});
          if (!el) return { found: false };
          return { found: true, value: el.getAttribute(${JSON.stringify(cmd.name)}) };
        })()`,
      );
    }

    case "click": {
      return runInTab(
        id,
        `(() => {
          const sel = ${JSON.stringify(cmd.selector)};
          const el = document.querySelector(sel);
          if (!el) return { ok: false, reason: "not found", selector: sel };
          el.scrollIntoView({ block: "center", inline: "center" });
          el.click();
          return {
            ok: true,
            tag: el.tagName,
            text: (el.innerText || el.textContent || "").trim().slice(0, 300)
          };
        })()`,
      );
    }

    case "type": {
      return runInTab(
        id,
        `(() => {
          const sel = ${JSON.stringify(cmd.selector)};
          const text = ${JSON.stringify(cmd.text ?? "")};
          const el = document.querySelector(sel);
          if (!el) return { ok: false, reason: "not found", selector: sel };
          el.scrollIntoView({ block: "center" });
          el.focus();
          if (el.isContentEditable) {
            el.textContent = text;
          } else {
            const proto = el.tagName === "TEXTAREA"
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
            setter.call(el, text);
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, value: el.value ?? el.textContent };
        })()`,
      );
    }

    case "press": {
      return runInTab(
        id,
        `(() => {
          const el = document.querySelector(${JSON.stringify(cmd.selector)}) || document.activeElement;
          if (!el) return { ok: false, reason: "no element" };
          const key = ${JSON.stringify(cmd.key || "Enter")};
          for (const type of ["keydown", "keypress", "keyup"]) {
            el.dispatchEvent(new KeyboardEvent(type, {
              key, code: key, bubbles: true, cancelable: true
            }));
          }
          return { ok: true, key };
        })()`,
      );
    }

    case "scroll": {
      return runInTab(
        id,
        `(() => {
          window.scrollBy(${Number(cmd.x) || 0}, ${Number(cmd.y) || 0});
          return { x: window.scrollX, y: window.scrollY };
        })()`,
      );
    }

    case "wait": {
      return waitForSelector(id, cmd.selector, cmd.timeout || 15000);
    }

    case "sleep": {
      await sleep(Math.min(Number(cmd.ms) || 1000, 120000));
      return { sleptMs: Math.min(Number(cmd.ms) || 1000, 120000) };
    }

    case "eval": {
      if (!cmd.code) throw new Error("eval: code is required");
      return runInTab(id, `(() => { return (${cmd.code}); })()`);
    }

    case "screenshot": {
      const tabId = await resolveTabId(id);
      const dataUrl = await browser.tabs.captureTab(tabId, { format: "png" });
      return { tabId, dataUrl };
    }

    default:
      throw new Error(`unknown action: ${cmd.action}`);
  }
}

async function pollOnce() {
  if (stopped) return;
  try {
    const res = await api("/next");
    if (res.status === 204) return;
    if (!res.ok) throw new Error(`next failed: ${res.status}`);
    const cmd = await res.json();
    let payload;
    try {
      payload = { id: cmd.id, ok: true, data: await exec(cmd) };
    } catch (err) {
      payload = {
        id: cmd.id,
        ok: false,
        error: String((err && err.stack) || err),
      };
    }
    await api("/result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[assist] poll error:", err);
    await sleep(1000);
  }
}

async function loop() {
  while (!stopped) {
    await pollOnce();
    await sleep(POLL_IDLE_MS);
  }
}

loop();
