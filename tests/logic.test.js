const test = require("node:test");
const assert = require("node:assert");
const L = require("../logic.js");

const TODAY = "2026-11-18";
const seed = () => L.seedState(TODAY);
const plan = (over) => ({ title: "T", type: "trip", date: "", place: "", desc: "", emoji: "", ...over });

test("seed dates are computed relative to today", () => {
  const dates = seed().plans.map((p) => p.date).sort();
  assert.deepStrictEqual(dates, ["2026-12-05", "2026-12-12", "2026-12-19"]);
  assert.strictEqual(seed().plans.length, 3);
  assert.strictEqual(seed().tasks.length, 5);
  assert.strictEqual(seed().memories.length, 0);
});

test("addDays and daysBetween cross month and leap-year boundaries", () => {
  assert.strictEqual(L.addDays("2026-11-30", 1), "2026-12-01");
  assert.strictEqual(L.addDays("2028-02-28", 1), "2028-02-29");
  assert.strictEqual(L.addDays("2027-02-28", 1), "2027-03-01");
  assert.strictEqual(L.daysBetween("2026-11-18", "2026-11-30"), 12);
  assert.strictEqual(L.daysBetween("2026-11-18", "2026-11-13"), -5);
});

test("parseKey rejects impossible dates", () => {
  assert.strictEqual(L.parseKey("2026-02-30"), null);
  assert.strictEqual(L.parseKey("2026-2-3"), null);
  assert.deepStrictEqual(L.parseKey("2028-02-29"), { year: 2028, month: 1, day: 29 });
});

test("countdownLabel words", () => {
  assert.strictEqual(L.countdownLabel("2026-11-30", TODAY), "in 12 days");
  assert.strictEqual(L.countdownLabel(TODAY, TODAY), "today");
  assert.strictEqual(L.countdownLabel("2026-11-13", TODAY), "5 days ago");
  assert.strictEqual(L.countdownLabel("2026-11-19", TODAY), "tomorrow");
  assert.strictEqual(L.countdownLabel("", TODAY), "");
});

test("upcomingPlans excludes yesterday, includes today, sorts ascending, skips undated", () => {
  const s = { ...seed(), plans: [
    { id: "a", ...plan({ title: "later", date: "2026-12-01" }) },
    { id: "b", ...plan({ title: "yesterday", date: "2026-11-17" }) },
    { id: "c", ...plan({ title: "today", date: TODAY }) },
    { id: "d", ...plan({ title: "undated" }) },
  ] };
  assert.deepStrictEqual(L.upcomingPlans(s, TODAY).map((p) => p.title), ["today", "later"]);
});

test("stats counts upcoming and open tasks truthfully", () => {
  const s = { ...seed(), plans: [
    { id: "a", ...plan({ date: "2026-11-01" }) },
    { id: "b", ...plan({ date: "2026-12-01" }) },
    { id: "c", ...plan({}) },
  ] };
  assert.deepStrictEqual(L.stats(s, TODAY), { plans: 3, upcoming: 1, openTasks: 4 });
});

test("monthGrid November 2026 starts on Sunday Nov 1 with 7-cell rows", () => {
  const weeks = L.monthGrid(2026, 10);
  assert.strictEqual(weeks[0][0].date, "2026-11-01");
  assert.strictEqual(weeks[0][0].inMonth, true);
  assert.strictEqual(weeks.length, 5);
  for (const w of weeks) assert.strictEqual(w.length, 7);
  const last = weeks[4][6];
  assert.strictEqual(last.date, "2026-12-05");
  assert.strictEqual(last.inMonth, false);
});

test("monthGrid marks leading days from the previous month", () => {
  const weeks = L.monthGrid(2026, 11);
  assert.strictEqual(weeks[0][0].date, "2026-11-29");
  assert.strictEqual(weeks[0][0].inMonth, false);
  assert.strictEqual(weeks[0][2].date, "2026-12-01");
  assert.strictEqual(weeks[0][2].inMonth, true);
});

test("monthGrid February 2028 contains the 29th and February 2027 does not", () => {
  const inMonthDays = (y) => L.monthGrid(y, 1).flat().filter((c) => c.inMonth).map((c) => c.day);
  assert.ok(inMonthDays(2028).includes(29));
  assert.strictEqual(inMonthDays(2028).length, 29);
  assert.strictEqual(inMonthDays(2027).length, 28);
});

test("monthGrid can need six weeks", () => {
  const weeks = L.monthGrid(2026, 7);
  assert.strictEqual(weeks.length, 6);
  assert.strictEqual(weeks[0][0].date, "2026-07-26");
});

test("shiftMonth wraps across years", () => {
  assert.deepStrictEqual(L.shiftMonth({ year: 2026, month: 11 }, 1), { year: 2027, month: 0 });
  assert.deepStrictEqual(L.shiftMonth({ year: 2026, month: 0 }, -1), { year: 2025, month: 11 });
});

test("deleting a plan removes its tasks and keeps general tasks", () => {
  let s = seed();
  const pid = s.plans[0].id;
  s = L.addTask(s, { text: "pack", planId: pid }, "t-x");
  s = L.addTask(s, { text: "pack more", planId: pid }, "t-y");
  s = L.deletePlan(s, pid);
  assert.strictEqual(s.plans.some((p) => p.id === pid), false);
  assert.strictEqual(s.tasks.some((t) => t.planId === pid), false);
  assert.strictEqual(s.tasks.filter((t) => t.planId === null).length, 5);
});

test("toggling a task twice restores it, and never mutates the input", () => {
  const s = seed();
  const once = L.toggleTask(s, "seed-task-1");
  assert.strictEqual(once.tasks[0].done, true);
  assert.strictEqual(s.tasks[0].done, false);
  assert.deepStrictEqual(L.toggleTask(once, "seed-task-1"), s);
});

test("addTask ignores blank text and unknown plans", () => {
  const s = seed();
  assert.strictEqual(L.addTask(s, { text: "   ", planId: null }, "n"), s);
  assert.strictEqual(L.addTask(s, { text: "x", planId: "nope" }, "n"), s);
  assert.strictEqual(L.addTask(s, { text: " x ", planId: null }, "n").tasks.at(-1).text, "x");
});

test("deleteTask removes only that task", () => {
  const s = L.deleteTask(seed(), "seed-task-2");
  assert.deepStrictEqual(s.tasks.map((t) => t.id), ["seed-task-1", "seed-task-3", "seed-task-4", "seed-task-5"]);
});

test("addPlan prepends, defaults the emoji from the type, and updatePlan keeps the id", () => {
  let s = L.addPlan(seed(), plan({ title: " Picnic ", type: "outing", date: "2026-12-24" }), "p-new");
  assert.strictEqual(s.plans[0].id, "p-new");
  assert.strictEqual(s.plans[0].title, "Picnic");
  assert.strictEqual(s.plans[0].emoji, L.PLAN_TYPES.outing.emoji);
  s = L.updatePlan(s, "p-new", plan({ title: "Picnic 2", type: "event", date: "", emoji: "🎬" }));
  assert.deepStrictEqual(s.plans[0], { id: "p-new", title: "Picnic 2", type: "event", date: "", place: "", desc: "", emoji: "🎬" });
});

test("addPlan coerces an unknown type to other and drops an invalid date", () => {
  const p = L.addPlan(seed(), plan({ type: "bogus", date: "2026-13-40" }), "x").plans[0];
  assert.strictEqual(p.type, "other");
  assert.strictEqual(p.date, "");
});

test("filterPlans by type and by case-insensitive query including place and notes", () => {
  const s = seed();
  assert.deepStrictEqual(L.filterPlans(s, { type: "trip" }).map((p) => p.title), ["Coastal getaway"]);
  assert.deepStrictEqual(L.filterPlans(s, { query: "SANTA CRUZ" }).map((p) => p.title), ["Coastal getaway"]);
  assert.deepStrictEqual(L.filterPlans(s, { query: "cocoa" }).map((p) => p.title), ["Holiday lights outing"]);
  assert.deepStrictEqual(L.filterPlans(s, { type: "event", query: "santa" }), []);
  assert.strictEqual(L.filterPlans(s, {}).length, 3);
});

test("plansByDate groups same-day plans and skips undated ones", () => {
  const s = { ...seed(), plans: [
    { id: "a", ...plan({ title: "A", date: "2026-12-01" }) },
    { id: "b", ...plan({ title: "B", date: "2026-12-01" }) },
    { id: "c", ...plan({ title: "C" }) },
  ] };
  const m = L.plansByDate(s);
  assert.deepStrictEqual(Object.keys(m), ["2026-12-01"]);
  assert.deepStrictEqual(m["2026-12-01"].map((p) => p.title), ["A", "B"]);
});

test("plansInMonth returns only that month, sorted", () => {
  const s = { ...seed(), plans: [
    { id: "a", ...plan({ title: "dec late", date: "2026-12-20" }) },
    { id: "b", ...plan({ title: "nov", date: "2026-11-05" }) },
    { id: "c", ...plan({ title: "dec early", date: "2026-12-02" }) },
  ] };
  assert.deepStrictEqual(L.plansInMonth(s, 2026, 11).map((p) => p.title), ["dec early", "dec late"]);
});

test("parseState falls back to the seed on corrupt or missing data", () => {
  assert.deepStrictEqual(L.parseState("not json", TODAY), seed());
  assert.deepStrictEqual(L.parseState(null, TODAY), seed());
  assert.deepStrictEqual(L.parseState('{"version":2,"plans":[],"tasks":[],"memories":[]}', TODAY), seed());
  assert.deepStrictEqual(L.parseState('{"version":1,"plans":{}}', TODAY), seed());
});

test("parseState round-trips a valid state exactly", () => {
  let s = L.addMemory(seed(), { title: "Day", tags: ["a"], hasPhoto: true, date: "2026-11-02" }, "m1");
  s = L.addTask(s, { text: "x", planId: s.plans[0].id }, "t9");
  assert.deepStrictEqual(L.parseState(JSON.stringify(s), TODAY), s);
});

test("parseState drops malformed items and orphaned tasks", () => {
  const raw = JSON.stringify({
    version: 1,
    plans: [{ id: "p1", title: "Ok", type: "weird", date: "2026-02-30" }, { id: "p2" }, null],
    tasks: [{ id: "t1", text: "keep", done: true, planId: "p1" }, { id: "t2", text: "orphan", done: false, planId: "gone" }, { id: "t3", text: 5 }],
    memories: [{ id: "m1", title: "Hi", tags: ["x", 3] }, { title: "no id" }],
  });
  const s = L.parseState(raw, TODAY);
  assert.deepStrictEqual(s.plans, [{ id: "p1", title: "Ok", type: "other", date: "", place: "", desc: "", emoji: "✨" }]);
  assert.deepStrictEqual(s.tasks.map((t) => t.id), ["t1"]);
  assert.deepStrictEqual(s.memories.map((m) => [m.id, m.tags]), [["m1", ["x"]]]);
});

test("memories need a title, text or photo, and deleting removes only that one", () => {
  const s = seed();
  assert.strictEqual(L.addMemory(s, { title: " ", text: "", hasPhoto: false }, "m"), s);
  let t = L.addMemory(s, { text: "sunny" }, "m1");
  t = L.addMemory(t, { hasPhoto: true }, "m2");
  assert.deepStrictEqual(t.memories.map((m) => m.id), ["m2", "m1"]);
  assert.deepStrictEqual(L.deleteMemory(t, "m2").memories.map((m) => m.id), ["m1"]);
});

test("parseTags splits on commas, trims, strips leading # and drops blanks", () => {
  assert.deepStrictEqual(L.parseTags(" beach, #sun ,, fun "), ["beach", "sun", "fun"]);
  assert.deepStrictEqual(L.parseTags(""), []);
});

test("tasksFor and progress report per-list counts", () => {
  let s = L.addTask(seed(), { text: "a", planId: "seed-plan-1" }, "t1");
  s = L.addTask(s, { text: "b", planId: "seed-plan-1" }, "t2");
  s = L.toggleTask(s, "t1");
  assert.deepStrictEqual(L.progress(L.tasksFor(s, "seed-plan-1")), { done: 1, total: 2 });
  assert.deepStrictEqual(L.progress(L.tasksFor(s, null)), { done: 1, total: 5 });
});

test("PLAN_TYPES is the single table the four types come from", () => {
  assert.deepStrictEqual(Object.keys(L.PLAN_TYPES), ["trip", "event", "outing", "other"]);
  for (const t of Object.values(L.PLAN_TYPES)) {
    assert.ok(t.label && t.formLabel && t.cover && t.emoji && t.filter);
    assert.ok(L.EMOJI_CHOICES.includes(t.emoji));
  }
});

test("escapeHtml escapes markup and quotes", () => {
  assert.strictEqual(L.escapeHtml(`<img src="x" onerror='a&b'>`), "&lt;img src=&quot;x&quot; onerror=&#39;a&amp;b&#39;&gt;");
});

const JPEG = "data:image/jpeg;base64,/9j/4AAQ";

test("fromLegacy converts template plans, {t,done} tasks and photo memories to the v1 shape", () => {
  const { state, photos } = L.fromLegacy({
    plans: JSON.stringify([{ id: 1700000000000, title: " Lake day ", type: "outing", date: "2026-12-12", place: "Tahoe", desc: "swim", emoji: "🧋" }]),
    tasks: JSON.stringify([{ t: "Pack towels", done: true }, { t: "Buy snacks", done: false }]),
    memories: JSON.stringify([{ id: 1700000000001, title: "Sunset", date: "2026-11-02", mood: "Happy ☀️", text: "pink sky", photo: JPEG, tags: ["sky"] }]),
  }, TODAY);
  assert.deepStrictEqual(state, {
    version: 1,
    plans: [{ id: "legacy-plan-0", title: "Lake day", type: "outing", date: "2026-12-12", place: "Tahoe", desc: "swim", emoji: "🧋" }],
    tasks: [
      { id: "legacy-task-0", text: "Pack towels", done: true, planId: null },
      { id: "legacy-task-1", text: "Buy snacks", done: false, planId: null },
    ],
    memories: [{ id: "legacy-memory-0", title: "Sunset", date: "2026-11-02", mood: "Happy ☀️", text: "pink sky", tags: ["sky"], hasPhoto: true }],
  });
  assert.deepStrictEqual(photos, [{ id: "legacy-memory-0", dataUrl: JPEG }]);
});

test("fromLegacy output survives parseState unchanged", () => {
  const { state } = L.fromLegacy({ plans: JSON.stringify([{ id: 3, title: "A", type: "trip" }]), tasks: "[]", memories: JSON.stringify([{ id: 9, text: "hi" }]) }, TODAY);
  assert.deepStrictEqual(L.parseState(JSON.stringify(state), TODAY), state);
});

test("fromLegacy is deterministic, so a rerun after a crash yields the same ids", () => {
  const raw = { plans: JSON.stringify([{ id: 5, title: "X", type: "event" }]), tasks: null, memories: JSON.stringify([{ id: 7, title: "M", photo: JPEG }]) };
  assert.deepStrictEqual(L.fromLegacy(raw, TODAY), L.fromLegacy(raw, TODAY));
});

test("fromLegacy uses the seed for a missing or corrupt key, as the template showed its defaults", () => {
  const { state, photos } = L.fromLegacy({ plans: null, tasks: "{oops", memories: null }, TODAY);
  assert.deepStrictEqual(state.plans, seed().plans);
  assert.deepStrictEqual(state.tasks, seed().tasks);
  assert.deepStrictEqual(state.memories, []);
  assert.deepStrictEqual(photos, []);
});

test("fromLegacy drops blank tasks and plans, empty memories, and non-image photos", () => {
  const { state, photos } = L.fromLegacy({
    plans: JSON.stringify([{ id: 1, title: "  " }, null]),
    tasks: JSON.stringify([{ t: " " }, { t: 4 }, { t: "ok" }]),
    memories: JSON.stringify([{ id: 1 }, { id: 2, title: "kept", photo: "javascript:alert(1)" }]),
  }, TODAY);
  assert.deepStrictEqual(state.plans, []);
  assert.deepStrictEqual(state.tasks.map((t) => [t.id, t.text]), [["legacy-task-2", "ok"]]);
  assert.deepStrictEqual(state.memories.map((m) => [m.id, m.hasPhoto]), [["legacy-memory-1", false]]);
  assert.deepStrictEqual(photos, []);
});
