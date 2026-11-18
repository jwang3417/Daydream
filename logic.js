(function (root) {
  "use strict";

  const PLAN_TYPES = Object.freeze({
    trip: { label: "Vacation", formLabel: "Vacation / Trip", cover: "cover-trip", emoji: "🏖️", filter: "Vacations" },
    event: { label: "Event", formLabel: "Event / Party", cover: "cover-event", emoji: "🎉", filter: "Events" },
    outing: { label: "Outing", formLabel: "Outing / Activity", cover: "cover-outing", emoji: "🧋", filter: "Outings" },
    other: { label: "Other", formLabel: "Other plan", cover: "cover-other", emoji: "✨", filter: "Other" },
  });

  const EMOJI_CHOICES = Object.freeze(["🏖️", "🎉", "🧋", "✨", "🎂", "✈️", "🏕️", "🍽️", "🎬", "🌸"]);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  const pad = (n, w) => String(n).padStart(w, "0");

  // month is 0-based; overflowing month or day values roll into the adjacent month.
  function dateKey(year, month, day) {
    const t = new Date(Date.UTC(year, month, day));
    return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1, 2)}-${pad(t.getUTCDate(), 2)}`;
  }

  function parseKey(key) {
    const m = typeof key === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
    if (!m) return null;
    const year = +m[1], month = +m[2] - 1, day = +m[3];
    return dateKey(year, month, day) === key ? { year, month, day } : null;
  }

  const isDateKey = (key) => parseKey(key) !== null;

  function dateKeyFromDate(d) {
    return dateKey(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function addDays(key, n) {
    const p = parseKey(key);
    return dateKey(p.year, p.month, p.day + n);
  }

  function daysBetween(fromKey, toKey) {
    const a = parseKey(fromKey), b = parseKey(toKey);
    return Math.round((Date.UTC(b.year, b.month, b.day) - Date.UTC(a.year, a.month, a.day)) / 864e5);
  }

  function countdownLabel(date, today) {
    if (!isDateKey(date)) return "";
    const n = daysBetween(today, date);
    if (n === 0) return "today";
    if (n === 1) return "tomorrow";
    if (n === -1) return "yesterday";
    return n > 0 ? `in ${n} days` : `${-n} days ago`;
  }

  function shiftMonth(cursor, delta) {
    const t = new Date(Date.UTC(cursor.year, cursor.month + delta, 1));
    return { year: t.getUTCFullYear(), month: t.getUTCMonth() };
  }

  function monthGrid(year, month) {
    const lead = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const weeks = [];
    for (let w = 0; w < Math.ceil((lead + length) / 7); w++) {
      const week = [];
      for (let d = 0; d < 7; d++) {
        const t = new Date(Date.UTC(year, month, 1 - lead + w * 7 + d));
        week.push({
          date: dateKey(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()),
          day: t.getUTCDate(),
          inMonth: t.getUTCMonth() === month,
        });
      }
      weeks.push(week);
    }
    return weeks;
  }

  function seedState(today) {
    return {
      version: 1,
      plans: [
        { id: "seed-plan-1", title: "Coastal getaway", type: "trip", date: addDays(today, 24), place: "Santa Cruz", desc: "Beach walks, sunset, and a cozy weekend.", emoji: "🏖️" },
        { id: "seed-plan-2", title: "Birthday dinner", type: "event", date: addDays(today, 17), place: "Home", desc: "Plan food, decorations, and invite everyone.", emoji: "🎂" },
        { id: "seed-plan-3", title: "Holiday lights outing", type: "outing", date: addDays(today, 31), place: "Downtown", desc: "Hot cocoa and a walk to see the lights.", emoji: "✨" },
      ],
      tasks: [
        { id: "seed-task-1", text: "Make a guest list", done: false, planId: null },
        { id: "seed-task-2", text: "Pick a place to stay", done: false, planId: null },
        { id: "seed-task-3", text: "Save inspiration photos", done: true, planId: null },
        { id: "seed-task-4", text: "Check the weather", done: false, planId: null },
        { id: "seed-task-5", text: "Make a packing list", done: false, planId: null },
      ],
      memories: [],
    };
  }

  const str = (v) => (typeof v === "string" ? v : "");
  const isId = (v) => typeof v === "string" && v !== "";

  function cleanPlan(f) {
    const type = Object.hasOwn(PLAN_TYPES, f.type) ? f.type : "other";
    return {
      title: str(f.title).trim(),
      type,
      date: isDateKey(f.date) ? f.date : "",
      place: str(f.place).trim(),
      desc: str(f.desc).trim(),
      emoji: str(f.emoji) || PLAN_TYPES[type].emoji,
    };
  }

  function cleanMemory(f) {
    return {
      title: str(f.title).trim(),
      date: isDateKey(f.date) ? f.date : "",
      mood: str(f.mood),
      text: str(f.text).trim(),
      tags: Array.isArray(f.tags) ? f.tags.filter((t) => typeof t === "string" && t !== "") : [],
      hasPhoto: f.hasPhoto === true,
    };
  }

  // The only place stored JSON is trusted-or-rejected. Everything else assumes the shape.
  function parseState(raw, today) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return seedState(today);
    }
    if (!data || data.version !== 1 || !Array.isArray(data.plans) || !Array.isArray(data.tasks) || !Array.isArray(data.memories)) {
      return seedState(today);
    }
    const plans = data.plans
      .filter((p) => p && isId(p.id) && str(p.title).trim() !== "")
      .map((p) => ({ id: p.id, ...cleanPlan(p) }));
    const planIds = new Set(plans.map((p) => p.id));
    const tasks = data.tasks
      .filter((t) => t && isId(t.id) && str(t.text) !== "" && (t.planId === null || planIds.has(t.planId)))
      .map((t) => ({ id: t.id, text: t.text, done: t.done === true, planId: t.planId }));
    const memories = data.memories
      .filter((m) => m && isId(m.id))
      .map((m) => ({ id: m.id, ...cleanMemory(m) }));
    return { version: 1, plans, tasks, memories };
  }

  function addPlan(state, fields, id) {
    return { ...state, plans: [{ id, ...cleanPlan(fields) }, ...state.plans] };
  }

  function updatePlan(state, id, fields) {
    return { ...state, plans: state.plans.map((p) => (p.id === id ? { id, ...cleanPlan(fields) } : p)) };
  }

  function deletePlan(state, id) {
    return {
      ...state,
      plans: state.plans.filter((p) => p.id !== id),
      tasks: state.tasks.filter((t) => t.planId !== id),
    };
  }

  function addTask(state, { text, planId }, id) {
    const clean = str(text).trim();
    if (!clean || (planId !== null && !state.plans.some((p) => p.id === planId))) return state;
    return { ...state, tasks: [...state.tasks, { id, text: clean, done: false, planId }] };
  }

  function toggleTask(state, id) {
    return { ...state, tasks: state.tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)) };
  }

  function deleteTask(state, id) {
    return { ...state, tasks: state.tasks.filter((t) => t.id !== id) };
  }

  function parseTags(s) {
    return str(s).split(",").map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
  }

  function canSaveMemory(fields) {
    const m = cleanMemory(fields);
    return m.title !== "" || m.text !== "" || m.hasPhoto;
  }

  function addMemory(state, fields, id) {
    if (!canSaveMemory(fields)) return state;
    return { ...state, memories: [{ id, ...cleanMemory(fields) }, ...state.memories] };
  }

  function deleteMemory(state, id) {
    return { ...state, memories: state.memories.filter((m) => m.id !== id) };
  }

  function upcomingPlans(state, today) {
    return state.plans.filter((p) => p.date !== "" && p.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  }

  function filterPlans(state, { type = "all", query = "" } = {}) {
    const q = query.trim().toLowerCase();
    return state.plans.filter(
      (p) => (type === "all" || p.type === type) && (q === "" || `${p.title} ${p.place} ${p.desc}`.toLowerCase().includes(q)),
    );
  }

  function plansByDate(state) {
    const byDate = {};
    for (const p of state.plans) if (p.date !== "") (byDate[p.date] ||= []).push(p);
    return byDate;
  }

  function plansInMonth(state, year, month) {
    const prefix = dateKey(year, month, 1).slice(0, 7);
    return state.plans.filter((p) => p.date.startsWith(prefix)).sort((a, b) => a.date.localeCompare(b.date));
  }

  const tasksFor = (state, planId) => state.tasks.filter((t) => t.planId === planId);

  function progress(tasks) {
    return { done: tasks.filter((t) => t.done).length, total: tasks.length };
  }

  function stats(state, today) {
    return {
      plans: state.plans.length,
      upcoming: upcomingPlans(state, today).length,
      openTasks: state.tasks.filter((t) => !t.done).length,
    };
  }

  const api = {
    PLAN_TYPES, EMOJI_CHOICES, escapeHtml,
    dateKey, parseKey, isDateKey, dateKeyFromDate, addDays, daysBetween, countdownLabel, shiftMonth, monthGrid,
    seedState, parseState,
    addPlan, updatePlan, deletePlan, addTask, toggleTask, deleteTask, parseTags, canSaveMemory, addMemory, deleteMemory,
    upcomingPlans, filterPlans, plansByDate, plansInMonth, tasksFor, progress, stats,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DaydreamLogic = api;
})(typeof window !== "undefined" ? window : globalThis);
