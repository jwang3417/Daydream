// Drives index.html in headless Chrome over CDP. Usage: node scripts/e2e.js
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL_ = "file://" + path.resolve(__dirname, "..", "index.html");
const KEY = "daydream.v1";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "daydream-e2e-"));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

async function scenario(name, run) {
  try {
    await run();
  } catch (err) {
    check(`${name} (scenario threw)`, false, err.message.split("\n")[0]);
  }
}

async function attach(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map((a) => a.value).join(" "));
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed: " + expr);
    return r.result.result.value;
  };
  const q = (sel, n = 0) => `document.querySelectorAll(${JSON.stringify(sel)})[${n}]`;
  const center = async (sel, n = 0) => {
    const p = await ev(`(() => { const el = ${q(sel, n)}; if (!el) return null; el.scrollIntoView({ block: "center" }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!p) throw new Error(`no element ${sel}[${n}]`);
    return p;
  };
  const mouse = (type, p, buttons) => send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1 });
  const VK = { Enter: 13, Escape: 27, Tab: 9 };
  const page = {
    send, ev, close: () => ws.close(),
    click: (sel, n = 0) => ev(`${q(sel, n)}.click()`),
    text: (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`),
    count: (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`),
    value: (sel) => ev(`${q(sel)}?.value ?? null`),
    focused: () => ev(`(() => { const a = document.activeElement; return a.dataset.action || a.id || a.name || a.tagName; })()`),
    setValue: (sel, v) => ev(`(() => { const el = ${q(sel)}; el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); })()`),
    stored: () => ev(`JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}))`),
    go: async (hash) => { await ev(`location.hash=${JSON.stringify(hash)}`); await sleep(100); },
    async tap(sel, n = 0) {
      const p = await center(sel, n);
      await mouse("mouseMoved", p);
      await mouse("mousePressed", p, 1);
      await mouse("mouseReleased", p, 0);
      await sleep(100);
    },
    async drag(fromSel, to) {
      const from = await center(fromSel);
      await mouse("mouseMoved", from);
      await mouse("mousePressed", from, 1);
      await mouse("mouseMoved", to, 1);
      await mouse("mouseReleased", to, 0);
      await sleep(100);
    },
    async tapAt(p) {
      await mouse("mouseMoved", p);
      await mouse("mousePressed", p, 1);
      await mouse("mouseReleased", p, 0);
      await sleep(100);
    },
    type: async (text) => { await send("Input.insertText", { text }); await sleep(50); },
    async press(key, shift = false) {
      const base = { key, code: key, windowsVirtualKeyCode: VK[key], modifiers: shift ? 8 : 0 };
      await send("Input.dispatchKeyEvent", key === "Enter" ? { type: "keyDown", text: "\r", ...base } : { type: "rawKeyDown", ...base });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      await sleep(100);
    },
    async load(url) {
      await send("Page.navigate", { url });
      await page.ready();
    },
    async reload() {
      await send("Page.reload");
      await sleep(100);
      await page.ready();
    },
    async ready() {
      for (let i = 0; i < 50; i++) {
        if (await ev(`document.readyState === "complete" && document.querySelectorAll("#nav button").length > 0`).catch(() => false)) return sleep(100);
        await sleep(100);
      }
      throw new Error("app did not boot");
    },
    async reset() {
      await ev(`(async () => {
        localStorage.clear();
        await new Promise((r) => { const d = indexedDB.deleteDatabase("daydream"); d.onsuccess = d.onerror = d.onblocked = r; });
        history.replaceState(null, "", "#/home");
      })()`);
      await page.reload();
    },
    jpegDataUrl: () => ev(`(() => { const c = document.createElement("canvas"); c.width = 40; c.height = 20; const x = c.getContext("2d"); x.fillStyle = "#c33"; x.fillRect(0, 0, 40, 20); return c.toDataURL("image/jpeg"); })()`),
    async pickPhoto() {
      await ev(`(async () => {
        const c = document.createElement("canvas"); c.width = 2400; c.height = 1200; c.getContext("2d").fillRect(0, 0, 2400, 1200);
        const blob = await new Promise((r) => c.toBlob(r, "image/png"));
        const dt = new DataTransfer(); dt.items.add(new File([blob], "big.png", { type: "image/png" }));
        const input = document.querySelector("#memoryPhoto"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await sleep(500);
    },
    photoCount: () => ev(`(async () => {
      const db = await new Promise((r) => { const q = indexedDB.open("daydream"); q.onsuccess = () => r(q.result); });
      if (!db.objectStoreNames.contains("photos")) return 0;
      return await new Promise((r) => { const q = db.transaction("photos").objectStore("photos").count(); q.onsuccess = () => r(q.result); });
    })()`),
    async newPlan(fields) {
      await page.click('[data-action="new-plan"]'); await sleep(100);
      for (const [sel, v] of Object.entries(fields)) await page.setValue(sel, v);
      await ev(`document.querySelector('[data-action="save-plan"]').requestSubmit()`); await sleep(150);
    },
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return page;
}

async function devtoolsPort() {
  const file = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file)) {
      const port = fs.readFileSync(file, "utf8").split("\n")[0].trim();
      if (port) return port;
    }
    await sleep(100);
  }
  throw new Error("Chrome did not write DevToolsActivePort");
}

async function main() {
  const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  try {
    const port = await devtoolsPort();
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
    const A = await attach(target.webSocketDebuggerUrl);
    await A.load(URL_ + "#/nope");
    const today = await A.ev(`new Date().toLocaleDateString("sv")`);
    const inDays = (n) => A.ev(`new Date(Date.now() + ${n} * 864e5).toLocaleDateString("sv")`);

    await scenario("boot and navigation", async () => {
      check("unknown hash normalised to #/home", (await A.ev("location.hash")) === "#/home");
      const stats = await A.ev(`[...document.querySelectorAll(".stat-number")].map(e => e.textContent)`);
      check("home stats are 3 plans, 3 upcoming, 4 open items", JSON.stringify(stats) === '["3","3","4"]', JSON.stringify(stats));
      check("home shows 3 plan cards and 3 timeline items", (await A.count(".plan-card")) === 3 && (await A.count(".timeline-item")) === 3);
      check("saved state is not written until the first change", (await A.stored()) === null);
      for (const r of ["plans", "calendar", "journal", "checklists", "home"]) {
        await A.click(`#nav [data-route="${r}"]`); await sleep(100);
        check(`nav to ${r} sets hash and aria-current`, (await A.ev("location.hash")) === `#/${r}` && (await A.ev(`document.querySelector("#nav [aria-current=page]").dataset.route`)) === r);
      }
      await A.ev("history.back()"); await sleep(100);
      check("back button returns to previous route", (await A.ev("location.hash")) === "#/checklists");
      await A.go("#/nope");
      check("unknown route falls back to home", (await A.ev("location.hash")) === "#/home");
    });

    await scenario("create, edit and delete a plan", async () => {
      await A.go("#/plans");
      await A.click('[data-action="new-plan"]'); await sleep(100);
      check("plan form opens with focus inside", (await A.focused()) === "planName");
      await A.setValue("#planName", "  <b>Ski trip</b>  ");
      await A.setValue("#planType", "event");
      check("emoji follows type default", (await A.value("[name=emoji]")) === "🎉");
      await A.click('[data-action="pick-emoji"][data-emoji="🎬"]');
      await A.setValue("#planDate", await inDays(5));
      await A.ev(`document.querySelector('[data-action="save-plan"]').requestSubmit()`); await sleep(150);
      check("new plan saved first, escaped, with chosen emoji", (await A.text(".plan-card .plan-open")) === "<b>Ski trip</b>" && (await A.count(".plan-card b")) === 0 && (await A.text(".plan-card .plan-cover")).includes("🎬"));
      check("plan persisted to localStorage", (await A.stored()).plans.length === 4);
      check("trigger button refocused after modal closed", (await A.focused()) === "new-plan");

      await A.click('[data-action="open-plan"]'); await sleep(100);
      await A.click('.modal [data-action="edit-plan"]'); await sleep(100);
      check("edit form is prefilled", (await A.value("#planName")) === "<b>Ski trip</b>");
      await A.setValue("#planName", "Ski weekend");
      await A.setValue("#planPlace", "Tahoe");
      await A.ev(`document.querySelector('[data-action="save-plan"]').requestSubmit()`); await sleep(150);
      check("edited plan shows the change", (await A.text(".plan-card .plan-open")) === "Ski weekend" && (await A.text(".plan-card .plan-meta")).includes("Tahoe") && (await A.count(".plan-card")) === 4);
      check("edit persisted without duplicating", (await A.stored()).plans.filter((p) => p.title === "Ski weekend").length === 1);

      await A.click('[data-action="open-plan"]'); await sleep(100);
      check("detail modal shows countdown", (await A.text(".modal .detail-line")).includes("in 5 days"));
      await A.ev(`(() => { const f = document.querySelector('.modal [data-action="add-task"]'); f.elements.text.value = "bring skis"; f.requestSubmit(); })()`); await sleep(100);
      check("task added to this plan", (await A.count(".modal .checkline")) === 1 && (await A.text(".modal h3 .progress")) === "0 of 1 done");
      await A.click('.modal [data-action="toggle-task"]'); await sleep(100);
      check("task toggled", (await A.text(".modal h3 .progress")) === "1 of 1 done");
      await A.click('.modal [data-action="ask-delete"]'); await sleep(100);
      check("delete asks for confirmation in the modal", (await A.text(".modal .confirm-text")).includes("1 checklist item") && (await A.count(".modal .button.danger")) === 1);
      await A.press("Escape");
      check("Escape closes modal and nothing was deleted", (await A.count(".modal")) === 0 && (await A.count(".plan-card")) === 4);
      await A.click('[data-action="open-plan"]'); await sleep(100);
      await A.click('.modal [data-action="ask-delete"]'); await A.click('.modal [data-action="delete-plan"]'); await sleep(150);
      check("confirmed delete removes plan and its tasks", (await A.count(".plan-card")) === 3 && (await A.stored()).tasks.length === 5);
      await A.click('[data-action="open-plan"]'); await sleep(100);
      await A.tapAt({ x: 5, y: 5 });
      check("backdrop click closes modal", (await A.count(".modal")) === 0);
    });

    await scenario("calendar", async () => {
      await A.reset();
      await A.go("#/plans");
      await A.newPlan({ "#planName": "Today thing", "#planDate": today });
      await A.go("#/calendar");
      check("calendar has 7-column rows", (await A.count(".cal-cell")) % 7 === 0);
      check("the one highlighted cell is today's date", (await A.count(".cal-cell.today")) === 1 && (await A.ev(`document.querySelector(".cal-cell.today .cal-day").dataset.date`)) === today);
      check("a calendar week lays out as one row of 7", await A.ev(`(() => { const c = [...document.querySelectorAll(".cal-cell")]; return c.slice(0, 7).every((x) => x.offsetTop === c[0].offsetTop) && c[7].offsetTop > c[0].offsetTop; })()`));
      check("today's plan chip sits in today's cell", (await A.ev(`[...document.querySelectorAll(".cal-cell.today .cal-chip")].map((c) => c.title).join()`)) === "Today thing");
      await A.tap(".cal-cell.today .cal-chip");
      check("chip opens that plan's detail", (await A.text("#modalTitle")) === "Today thing" && (await A.count(".modal .plan-cover")) === 1);
      await A.press("Escape");
      const monthBefore = await A.text(".section-head h2");
      await A.click('[data-action="cal-next"]'); await sleep(50);
      check("next month changes title", (await A.text(".section-head h2")) !== monthBefore);
      await A.click('[data-action="cal-today"]'); await sleep(50);
      check("Today returns to current month", (await A.text(".section-head h2")) === monthBefore);
      const clicked = await A.ev(`document.querySelector(".cal-cell.blank .cal-day").dataset.date`);
      await A.tap(".cal-cell.blank .cal-day");
      check("day click presets the form to that cell's date", (await A.value("#planDate")) === clicked, `${await A.value("#planDate")} vs ${clicked}`);
      await A.press("Escape");
    });

    await scenario("journal with a photo", async () => {
      await A.reset();
      await A.go("#/journal");
      await A.pickPhoto();
      check("photo preview shown", (await A.ev(`getComputedStyle(document.querySelector("#memoryPreview")).display`)) === "block");
      await A.setValue("#memoryTitle", "Beach <i>day</i>");
      await A.setValue("#memoryTags", "sun, #sea");
      await A.ev(`document.querySelector('[data-action="save-memory"]').requestSubmit()`); await sleep(700);
      check("memory card rendered with escaped title and tags", (await A.count(".memory-card")) === 1 && (await A.count(".memory-card i")) === 0 && (await A.count(".memory-tag")) === 2);
      check("journal form is cleared after saving", (await A.value("#memoryTitle")) === "" && (await A.ev(`getComputedStyle(document.querySelector("#memoryPreview")).display`)) === "none");
      const photo = await A.ev(`(async () => {
        const db = await new Promise((r) => { const q = indexedDB.open("daydream"); q.onsuccess = () => r(q.result); });
        const id = JSON.parse(localStorage.getItem("daydream.v1")).memories[0].id;
        const blob = await new Promise((r) => { const q = db.transaction("photos").objectStore("photos").get(id); q.onsuccess = () => r(q.result); });
        const bm = await createImageBitmap(blob);
        return { type: blob.type, w: bm.width, h: bm.height, lsHasData: localStorage.getItem("daydream.v1").includes("data:image") };
      })()`);
      check("photo stored in IndexedDB as 1000px JPEG, not in localStorage", photo.type === "image/jpeg" && photo.w === 1000 && photo.h === 500 && !photo.lsHasData, JSON.stringify(photo));
      check("card renders the stored photo", await A.ev(`!!document.querySelector(".memory-card img.memory-image[src^='blob:']")`));

      await A.tap(".memory-card .memory-delete");
      check("[6] first Delete click keeps the memory and asks to confirm", (await A.count(".memory-card")) === 1 && (await A.focused()) === "delete-memory" && (await A.count('[data-action="cancel-delete-memory"]')) === 1);
      await A.tap('[data-action="cancel-delete-memory"]');
      check("[6] Cancel keeps the memory", (await A.count(".memory-card")) === 1 && (await A.stored()).memories.length === 1 && (await A.text(".memory-card .memory-delete")) === "Delete entry");
      await A.tap(".memory-card .memory-delete");
      await A.tap('[data-action="delete-memory"]'); await sleep(300);
      check("deleting a memory removes its photo", (await A.count(".memory-card")) === 0 && (await A.photoCount()) === 0);
      await A.ev(`document.querySelector('[data-action="save-memory"]').requestSubmit()`); await sleep(100);
      check("empty memory shows inline message, no alert", (await A.text("#journalMsg")).length > 0);
    });

    await scenario("checklists", async () => {
      await A.reset();
      await A.go("#/checklists");
      check("checklists page has General card", (await A.text(".cards-2 .widget h3")).startsWith("General"));
      await A.ev(`(() => { const f = document.querySelector('.cards-2 [data-action="add-task"]'); f.elements.text.value = "new item"; f.requestSubmit(); })()`); await sleep(100);
      check("general task added", (await A.text(".cards-2 .widget h3 .progress")) === "1 of 6 done");
      check("[8] every plan has a card with an add box", (await A.count('.cards-2 [data-action="add-task"]')) === 4);
      await A.ev(`(() => { const f = document.querySelector('.cards-2 [data-plan-id="seed-plan-1"]'); f.elements.text.value = "only item"; f.requestSubmit(); })()`); await sleep(100);
      await A.tap('.cards-2 [data-action="delete-task"][aria-label="Delete only item"]');
      check("[8] removing a plan's last item keeps its card and add box", (await A.count('.cards-2 [data-plan-id="seed-plan-1"]')) === 1);
    });

    await scenario("[1] Enter cannot delete a plan", async () => {
      await A.reset();
      await A.go("#/plans");
      await A.click('[data-action="open-plan"]'); await sleep(100);
      await A.tap('.modal [data-action="ask-delete"]');
      check("[1] confirming moves focus to Yes, delete", (await A.focused()) === "delete-plan");
      await A.tap('.modal .add-task input');
      await A.type("milk");
      await A.press("Enter");
      await A.press("Enter");
      check("[1] two Enters in the checklist box add the item and keep the plan", (await A.count(".plan-card")) === 3 && (await A.count(".modal")) === 1 && (await A.count(".modal .checkline")) === 1, `cards ${await A.count(".plan-card")} modal ${await A.count(".modal")}`);
      check("[1] adding an item leaves the confirm state", (await A.count(".modal .confirm-text")) === 0);
      await A.press("Escape");
    });

    await scenario("[2] storage failure", async () => {
      await A.reset();
      await A.go("#/plans");
      await A.click('[data-action="new-plan"]'); await sleep(100);
      await A.type("Doomed");
      await A.ev(`window.__setItem = Storage.prototype.setItem; Storage.prototype.setItem = function () { throw new DOMException("full", "QuotaExceededError"); }`);
      await A.ev(`document.querySelector('[data-action="save-plan"]').requestSubmit()`); await sleep(150);
      check("[2] failed save shows only the failure message", (await A.text("#toast")).startsWith("Couldn't save"), await A.text("#toast"));
      check("[2] form stays open with the typed title", (await A.count(".modal")) === 1 && (await A.value("#planName")) === "Doomed");
      await A.press("Escape");
      check("[2] in-memory plans match storage after a failed save", (await A.count(".plan-card")) === 3, String(await A.count(".plan-card")));
      await A.go("#/home");
      await A.tap('[data-action="toggle-task"]');
      check("[2] a failed toggle leaves the box unticked", (await A.ev(`document.querySelector('[data-action="toggle-task"]').checked`)) === false && (await A.text(".stat:nth-child(3) .stat-number")) === "4");
      await A.ev(`Storage.prototype.setItem = window.__setItem`);
      await A.tap('[data-action="toggle-task"]');
      check("[2] saving works again once storage recovers", (await A.stored())?.tasks[0].done === true);
    });

    await scenario("[3] drag-select does not close the form", async () => {
      await A.reset();
      await A.go("#/plans");
      await A.click('[data-action="new-plan"]'); await sleep(100);
      await A.type("Picnic");
      await A.drag("#planName", { x: 5, y: 5 });
      check("[3] press inside, release on backdrop keeps the form and its text", (await A.count(".modal")) === 1 && (await A.value("#planName")) === "Picnic");
      await A.tapAt({ x: 5, y: 5 });
      check("[3] press and release on the backdrop closes it", (await A.count(".modal")) === 0);
    });

    await scenario("[4] a second tab's change is picked up", async () => {
      await A.reset();
      await A.go("#/plans");
      await A.click('[data-action="open-plan"][data-id="seed-plan-2"]'); await sleep(100);
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
      const B = await attach(t.webSocketDebuggerUrl);
      try {
        await B.load(URL_ + "#/plans");
        await B.click('[data-action="open-plan"][data-id="seed-plan-2"]'); await sleep(100);
        await B.click('.modal [data-action="ask-delete"]'); await B.click('.modal [data-action="delete-plan"]'); await sleep(200);
      } finally {
        B.close();
        await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
      }
      check("[4] other tab's delete shows here and closes the stale modal", (await A.count(".plan-card")) === 2 && (await A.count(".modal")) === 0, `cards ${await A.count(".plan-card")} modal ${await A.count(".modal")}`);
      await A.newPlan({ "#planName": "From tab A" });
      const titles = (await A.stored()).plans.map((p) => p.title);
      check("[4] this tab's next save keeps the other tab's change", titles.length === 3 && !titles.includes("Birthday dinner"), JSON.stringify(titles));
    });

    await scenario("[5] typed input survives a re-render", async () => {
      await A.reset();
      await A.go("#/plans");
      await A.click('[data-action="open-plan"]'); await sleep(100);
      await A.ev(`(() => { const f = document.querySelector('.modal [data-action="add-task"]'); f.elements.text.value = "a"; f.requestSubmit(); })()`); await sleep(100);
      await A.tap('.modal .add-task input');
      await A.type("half");
      await A.tap('.modal [data-action="toggle-task"]');
      check("[5] half-typed item survives ticking a box in the modal", (await A.value(".modal .add-task input")) === "half" && (await A.text(".modal h3 .progress")) === "1 of 1 done");
      await A.press("Escape");
      await A.go("#/checklists");
      await A.tap('.cards-2 .add-task input');
      await A.type("note");
      await A.tap('.cards-2 [data-action="toggle-task"]');
      check("[5] half-typed item survives ticking a box on the checklists page", (await A.value(".cards-2 .add-task input")) === "note");
    });

    await scenario("[8] journal draft survives search and navigation", async () => {
      await A.reset();
      await A.go("#/journal");
      await A.pickPhoto();
      await A.tap("#memoryTitle");
      await A.type("Half written");
      await A.tap("#memoryText");
      await A.type("still thinking");
      await A.tap("#search");
      await A.type("santa"); await sleep(100);
      check("typing in search from journal navigates to plans filtered", (await A.ev("location.hash")) === "#/plans" && (await A.count(".plan-card")) === 1);
      await A.setValue("#search", "");
      await A.go("#/journal");
      check("[8] journal title and text survive leaving and returning", (await A.value("#memoryTitle")) === "Half written" && (await A.value("#memoryText")) === "still thinking");
      check("[8] picked photo survives leaving and returning", (await A.ev(`getComputedStyle(document.querySelector("#memoryPreview")).display`)) === "block");
      await A.ev(`document.querySelector('[data-action="save-memory"]').requestSubmit()`); await sleep(700);
      check("[8] saving the restored draft keeps its photo", (await A.stored()).memories[0]?.hasPhoto === true && (await A.photoCount()) === 1);
    });

    await scenario("reload keeps plans, tasks and photo memories", async () => {
      await A.go("#/plans");
      await A.newPlan({ "#planName": "Survives reload" });
      await A.go("#/checklists");
      await A.ev(`(() => { const f = document.querySelector('.cards-2 [data-action="add-task"]'); f.elements.text.value = "sticky task"; f.requestSubmit(); })()`); await sleep(100);
      await A.reload();
      await A.go("#/plans");
      check("plan still there after reload", (await A.ev(`[...document.querySelectorAll(".plan-open")].some((b) => b.textContent === "Survives reload")`)));
      await A.go("#/checklists");
      check("task still there after reload", (await A.ev(`document.body.textContent.includes("sticky task")`)));
      await A.go("#/journal"); await sleep(300);
      check("photo memory still there after reload", (await A.count(".memory-card")) === 1 && (await A.ev(`!!document.querySelector(".memory-card img.memory-image[src^='blob:']")`)));
    });

    await scenario("[7] template data is migrated once", async () => {
      await A.reset();
      const photoUrl = await A.jpegDataUrl();
      await A.ev(`(() => {
        localStorage.setItem("daydreamPlans", JSON.stringify([{ id: 1700000000000, title: "Old picnic", type: "outing", date: "2026-12-12", place: "Park", desc: "", emoji: "🧋" }]));
        localStorage.setItem("daydreamTasks", JSON.stringify([{ t: "Old task", done: true }, { t: "Old open task", done: false }]));
        localStorage.setItem("daydreamMemories", JSON.stringify([{ id: 1700000000001, title: "Old memory", date: "2026-11-01", mood: "", text: "from the template", photo: ${JSON.stringify(photoUrl)}, tags: ["old"] }]));
      })()`);
      await A.reload();
      await A.go("#/plans");
      check("[7] template plans replace the seed", JSON.stringify(await A.ev(`[...document.querySelectorAll(".plan-open")].map((b) => b.textContent)`)) === '["Old picnic"]');
      await A.go("#/checklists");
      check("[7] template tasks keep their done state", (await A.text(".cards-2 .widget h3 .progress")) === "1 of 2 done");
      await A.go("#/journal"); await sleep(300);
      check("[7] template photo memory shows its photo from IndexedDB", (await A.text(".memory-card .memory-title")) === "Old memory" && (await A.ev(`!!document.querySelector(".memory-card img.memory-image[src^='blob:']")`)));
      const first = await A.stored();
      check("[7] migrated state is written once, photo out of localStorage", first?.memories[0]?.hasPhoto === true && !JSON.stringify(first).includes("data:image"));
      check("[7] legacy keys are left in place", (await A.ev(`["daydreamPlans", "daydreamTasks", "daydreamMemories"].every((k) => localStorage.getItem(k) !== null)`)));
      await A.ev(`localStorage.removeItem("daydream.v1")`);
      await A.reload();
      check("[7] rerunning after dying before the final write converges", JSON.stringify(await A.stored()) === JSON.stringify(first) && (await A.photoCount()) === 1);
    });

    await scenario("[9] focus stays inside an open modal", async () => {
      await A.reset();
      await A.go("#/plans");
      await A.click('[data-action="new-plan"]'); await sleep(100);
      await A.ev(`document.querySelector('.modal button[type="submit"]').focus()`);
      await A.press("Tab");
      check("[9] Tab from the last control wraps to the first", (await A.ev(`document.activeElement.matches(".modal .close")`)));
      await A.press("Tab", true);
      check("[9] Shift+Tab from the first control wraps to the last", (await A.ev(`document.activeElement.matches('.modal button[type="submit"]')`)));
      await A.press("Escape");
    });

    await scenario("[10] out-of-range years are rejected visibly", async () => {
      await A.click('[data-action="new-plan"]'); await sleep(100);
      await A.setValue("#planName", "Ancient");
      await A.setValue("#planDate", "0050-01-01");
      await A.ev(`document.querySelector('[data-action="save-plan"]').requestSubmit()`); await sleep(150);
      check("[10] plan form refuses a year before 0100", (await A.count(".modal")) === 1 && (await A.ev(`document.querySelector("#planDate").validity.rangeUnderflow`)));
      await A.press("Escape");
      await A.go("#/journal");
      check("[10] journal date is bounded the same way", (await A.ev(`document.querySelector("#memoryDate").min + " " + document.querySelector("#memoryDate").max`)) === "0100-01-01 9999-12-31");
    });

    await scenario("phone width", async () => {
      await A.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
      await sleep(200);
      for (const r of ["home", "plans", "calendar", "journal", "checklists"]) {
        await A.go(`#/${r}`);
        const w = await A.ev(`document.documentElement.scrollWidth`);
        const wide = w <= 375 ? "" : await A.ev(`[...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > 376).slice(0, 6).map(e => e.tagName + "." + e.className + ":" + Math.round(e.getBoundingClientRect().right)).join(" ")`);
        check(`no horizontal scroll at 375px on ${r}`, w <= 375, `scrollWidth ${w} ${wide}`);
      }
      await A.go("#/calendar");
      check("calendar chips collapse to emoji at phone width", (await A.count(".cal-chip")) === 0 || (await A.ev(`getComputedStyle(document.querySelector(".cal-chip .t")).display`)) === "none");
    });

    check("no console errors or exceptions", errors.length === 0, errors.join(" | "));
  } finally {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    await exited;
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
  console.log(failures ? `${failures} FAILED` : "ALL PASSED");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
