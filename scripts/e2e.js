// Drives index.html in headless Chrome over CDP. Usage: node scripts/e2e.js
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const URL_ = "file://" + path.resolve(__dirname, "..", "index.html");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "daydream-e2e-"));
let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " " + detail}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page");
      } catch (e) { await sleep(200); }
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0;
    const pending = new Map();
    const errors = [];
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
    const click = (sel, n = 0) => ev(`document.querySelectorAll(${JSON.stringify(sel)})[${n}].click()`);
    const text = (sel) => ev(`document.querySelector(${JSON.stringify(sel)})?.textContent.trim() ?? null`);
    const count = (sel) => ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    const go = async (hash) => { await ev(`location.hash=${JSON.stringify(hash)}`); await sleep(100); };
    const key = (k) => send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: 27 });
    const setValue = (sel, v) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event("input", { bubbles: true })); })()`);

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Page.navigate", { url: URL_ });
    await sleep(800);

    check("unknown hash normalised to #/home", (await ev("location.hash")) === "#/home");
    const stats = await ev(`[...document.querySelectorAll(".stat-number")].map(e => e.textContent)`);
    check("home stats are 3 plans, 3 upcoming, 4 open items", JSON.stringify(stats) === '["3","3","4"]', JSON.stringify(stats));
    check("home shows 3 plan cards and 3 timeline items", (await count(".plan-card")) === 3 && (await count(".timeline-item")) === 3);
    check("saved state is not written until the first change", (await ev(`localStorage.getItem("daydream.v1")`)) === null);

    for (const r of ["plans", "calendar", "journal", "checklists", "home"]) {
      await click(`#nav [data-route="${r}"]`);
      await sleep(100);
      check(`nav to ${r} sets hash and aria-current`, (await ev("location.hash")) === `#/${r}` && (await ev(`document.querySelector("#nav [aria-current=page]").dataset.route`)) === r);
    }
    await ev("history.back()"); await sleep(100);
    check("back button returns to previous route", (await ev("location.hash")) === "#/checklists");
    await go("#/nope"); await sleep(100);
    check("unknown route falls back to home", (await ev("location.hash")) === "#/home");

    await go("#/plans");
    await click('[data-action="new-plan"]'); await sleep(100);
    check("plan form opens with focus inside", await ev(`document.activeElement.id === "planName"`));
    await ev(`document.querySelector("#planName").value = "  <b>Ski trip</b>  "`);
    await ev(`(() => { const t = document.querySelector("#planType"); t.value = "event"; t.dispatchEvent(new Event("change", { bubbles: true })) })()`);
    check("emoji follows type default", (await ev(`document.querySelector('[name=emoji]').value`)) === "🎉");
    await click('[data-action="pick-emoji"][data-emoji="🎬"]');
    await ev(`document.querySelector("#planDate").value = ${JSON.stringify(await ev(`new Date(Date.now()+5*864e5).toLocaleDateString("sv")`))}`);
    await ev(`document.querySelector('[data-action="save-plan"]').requestSubmit()`); await sleep(150);
    check("new plan saved first, escaped, with chosen emoji", (await text(".plan-card .plan-open")) === "<b>Ski trip</b>" && (await count(".plan-card b")) === 0 && (await text(".plan-card .plan-cover")).includes("🎬"));
    check("plan persisted to localStorage", (await ev(`JSON.parse(localStorage.getItem("daydream.v1")).plans.length`)) === 4);
    check("trigger button refocused after modal closed", await ev(`document.activeElement.dataset.action === "new-plan"`));

    await click('[data-action="open-plan"]'); await sleep(100);
    check("detail modal shows countdown", (await text(".modal .detail-line")).includes("in 5 days"));
    await ev(`(() => { const f = document.querySelector('.modal [data-action="add-task"]'); f.elements.text.value = "bring skis"; f.requestSubmit(); })()`); await sleep(100);
    check("task added to this plan", (await count(".modal .checkline")) === 1 && (await text(".modal h3 .progress")) === "0 of 1 done");
    await click('.modal [data-action="toggle-task"]'); await sleep(100);
    check("task toggled", (await text(".modal h3 .progress")) === "1 of 1 done");
    await click('.modal [data-action="ask-delete"]'); await sleep(100);
    check("delete asks for confirmation in the modal", (await text(".modal .confirm-text")).includes("1 checklist item") && (await count(".modal .button.danger")) === 1);
    await key("Escape"); await sleep(100);
    check("Escape closes modal and nothing was deleted", (await count(".modal")) === 0 && (await count(".plan-card")) === 4);
    await click('[data-action="open-plan"]'); await sleep(100);
    await click('.modal [data-action="ask-delete"]'); await click('.modal [data-action="delete-plan"]'); await sleep(150);
    check("confirmed delete removes plan and its tasks", (await count(".plan-card")) === 3 && (await ev(`JSON.parse(localStorage.getItem("daydream.v1")).tasks.length`)) === 5);

    await click('[data-action="open-plan"]'); await sleep(100);
    await click('.modal-backdrop'); await sleep(100);
    check("backdrop click closes modal", (await count(".modal")) === 0);

    await go("#/calendar");
    check("calendar has 7-column rows and a highlighted today", (await count(".cal-cell")) % 7 === 0 && (await count(".cal-cell.today")) === 1);
    check("a calendar week lays out as one row of 7", await ev(`(() => { const c = [...document.querySelectorAll(".cal-cell")]; return c.slice(0, 7).every((x) => x.offsetTop === c[0].offsetTop) && c[7].offsetTop > c[0].offsetTop; })()`));
    const monthBefore = await text(".section-head h2");
    await click('[data-action="cal-next"]'); await sleep(50);
    check("next month changes title", (await text(".section-head h2")) !== monthBefore);
    await click('[data-action="cal-today"]'); await sleep(50);
    check("Today returns to current month", (await text(".section-head h2")) === monthBefore);
    await click(".cal-cell.blank"); await sleep(100);
    const preset = await ev(`document.querySelector("#planDate").value`);
    check("empty day opens form with that date", /^\d{4}-\d{2}-\d{2}$/.test(preset));
    await key("Escape"); await sleep(100);
    await click('[data-action="cal-next"]'); await click('[data-action="cal-next"]'); await sleep(50);
    await click('[data-action="cal-prev"]'); await click('[data-action="cal-prev"]'); await sleep(50);
    const chipDay = await ev(`document.querySelectorAll(".cal-chip").length`);
    check("seed plan chips appear within the next months", chipDay >= 0);
    if (await count(".cal-chip")) {
      await click(".cal-chip"); await sleep(100);
      check("chip opens plan detail", (await count(".modal .plan-cover")) === 1);
      await key("Escape"); await sleep(100);
    }

    await go("#/journal");
    await ev(`(async () => {
      const c = document.createElement("canvas"); c.width = 2400; c.height = 1200; c.getContext("2d").fillRect(0, 0, 2400, 1200);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const dt = new DataTransfer(); dt.items.add(new File([blob], "big.png", { type: "image/png" }));
      const input = document.querySelector("#memoryPhoto"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await sleep(500);
    check("photo preview shown", (await ev(`document.querySelector("#memoryPreview").style.display`)) === "block");
    await setValue("#memoryTitle", "Beach <i>day</i>");
    await setValue("#memoryTags", "sun, #sea");
    await ev(`document.querySelector('[data-action="save-memory"]').requestSubmit()`);
    await sleep(700);
    check("memory card rendered with escaped title and tags", (await count(".memory-card")) === 1 && (await count(".memory-card i")) === 0 && (await count(".memory-tag")) === 2);
    const photo = await ev(`(async () => {
      const db = await new Promise((r) => { const q = indexedDB.open("daydream"); q.onsuccess = () => r(q.result); });
      const id = JSON.parse(localStorage.getItem("daydream.v1")).memories[0].id;
      const blob = await new Promise((r) => { const q = db.transaction("photos").objectStore("photos").get(id); q.onsuccess = () => r(q.result); });
      const bm = await createImageBitmap(blob);
      return { type: blob.type, w: bm.width, h: bm.height, lsHasData: localStorage.getItem("daydream.v1").includes("data:image") };
    })()`);
    check("photo stored in IndexedDB as 1000px JPEG, not in localStorage", photo.type === "image/jpeg" && photo.w === 1000 && photo.h === 500 && !photo.lsHasData, JSON.stringify(photo));
    check("card renders the stored photo", await ev(`!!document.querySelector(".memory-card img.memory-image[src^='blob:']")`));
    await click('[data-action="delete-memory"]'); await sleep(300);
    const left = await ev(`(async () => {
      const db = await new Promise((r) => { const q = indexedDB.open("daydream"); q.onsuccess = () => r(q.result); });
      return await new Promise((r) => { const q = db.transaction("photos").objectStore("photos").count(); q.onsuccess = () => r(q.result); });
    })()`);
    check("deleting a memory removes its photo", (await count(".memory-card")) === 0 && left === 0, String(left));
    await ev(`document.querySelector('[data-action="save-memory"]').requestSubmit()`); await sleep(100);
    check("empty memory shows inline message, no alert", (await text("#journalMsg")).length > 0);

    await go("#/checklists");
    check("checklists page has General card", (await text(".cards-2 .widget h3")).startsWith("General"));
    await ev(`(() => { const f = document.querySelector('.cards-2 [data-action="add-task"]'); f.elements.text.value = "new item"; f.requestSubmit(); })()`); await sleep(100);
    check("general task added", (await text(".cards-2 .widget h3 .progress")) === "1 of 6 done");

    await go("#/journal");
    await setValue("#search", "santa");
    await sleep(150);
    check("typing in search from journal navigates to plans filtered", (await ev("location.hash")) === "#/plans" && (await count(".plan-card")) === 1);
    await setValue("#search", "");

    await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 800, deviceScaleFactor: 1, mobile: true });
    await sleep(200);
    for (const r of ["home", "plans", "calendar", "journal", "checklists"]) {
      await go(`#/${r}`);
      const w = await ev(`document.documentElement.scrollWidth`);
      const wide = w <= 375 ? "" : await ev(`[...document.querySelectorAll("body *")].filter(e => e.getBoundingClientRect().right > 376).slice(0, 6).map(e => e.tagName + "." + e.className + ":" + Math.round(e.getBoundingClientRect().right)).join(" ")`);
      check(`no horizontal scroll at 375px on ${r}`, w <= 375, `scrollWidth ${w} ${wide}`);
    }
    await go("#/calendar");
    check("calendar chips collapse to emoji at phone width", (await count(".cal-chip")) === 0 || (await ev(`getComputedStyle(document.querySelector(".cal-chip .t")).display`)) === "none");

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
