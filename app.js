(function () {
  "use strict";
  const L = window.DaydreamLogic;
  const e = L.escapeHtml;
  const { PLAN_TYPES } = L;

  const STORAGE_KEY = "daydream.v1";
  const PHOTO_MAX = 1000;
  const PHOTO_QUALITY = 0.78;

  const ROUTES = {
    home: { icon: "⌂", label: "Home", title: "Hey there, planner! ☁️", sub: "What are we dreaming up today?" },
    plans: { icon: "✧", label: "My Plans", title: "Your plans ✧", sub: "Everything you're looking forward to." },
    calendar: { icon: "▦", label: "Calendar", title: "Your calendar 📅", sub: "Every plan, right where it belongs." },
    journal: { icon: "♡", label: "Journal", title: "Your journal ♡", sub: "Little moments worth keeping." },
    checklists: { icon: "✓", label: "Checklists", title: "Checklists ☑", sub: "Little things to remember." },
  };

  const $ = (id) => document.getElementById(id);
  const todayKey = () => L.dateKeyFromDate(new Date());
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const localDate = (key) => {
    const p = L.parseKey(key);
    return new Date(p.year, p.month, p.day, 12);
  };
  const fmtDate = (key) =>
    key ? localDate(key).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "Date TBD";

  let state = loadState();
  const now = new Date();
  const ui = { route: "home", filter: "all", query: "", calendarCursor: { year: now.getFullYear(), month: now.getMonth() }, modal: null, drafts: {} };
  const draft = (k, fallback = "") => (Object.hasOwn(ui.drafts, k) ? ui.drafts[k] : fallback);
  function dropDrafts(prefix) {
    for (const k of Object.keys(ui.drafts)) if (k.startsWith(prefix)) delete ui.drafts[k];
  }

  function loadState() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      raw = null;
    }
    return L.parseState(raw, todayKey());
  }

  function commit(next, onSaved) {
    let saved = true;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (err) {
      saved = false;
      toast("Couldn't save to this browser. Storage may be full or blocked.");
    }
    if (saved) {
      state = next;
      if (onSaved) onSaved();
    }
    render();
    return saved;
  }

  let toastTimer;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
  }

  // Photos live in IndexedDB as Blobs, keyed by memory id.
  let dbPromise = null;
  function photoDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error("IndexedDB unavailable"));
        const req = indexedDB.open("daydream", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("photos");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  function photoTx(mode, run) {
    return photoDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction("photos", mode);
          const req = run(tx.objectStore("photos"));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = tx.onabort = () => reject(tx.error);
        }),
    );
  }

  const putPhoto = (id, blob) => photoTx("readwrite", (s) => s.put(blob, id));
  const getPhoto = (id) => photoTx("readonly", (s) => s.get(id));
  const removePhoto = (id) => photoTx("readwrite", (s) => s.delete(id));

  const photoUrls = new Map();
  function photoUrl(id) {
    if (!photoUrls.has(id)) {
      const p = getPhoto(id).then((blob) => (blob ? URL.createObjectURL(blob) : null));
      p.catch(() => photoUrls.delete(id));
      photoUrls.set(id, p);
    }
    return photoUrls.get(id);
  }

  function forgetPhoto(id) {
    const cached = photoUrls.get(id);
    photoUrls.delete(id);
    if (cached) cached.then((url) => url && URL.revokeObjectURL(url), () => {});
    removePhoto(id).catch(() => {});
  }

  function hydratePhotos() {
    document.querySelectorAll("[data-photo]").forEach((host) => {
      photoUrl(host.dataset.photo).then(
        (url) => {
          if (!url || !host.isConnected) return;
          const img = new Image();
          img.className = "memory-image";
          img.alt = host.dataset.alt;
          img.src = url;
          host.replaceChildren(img);
        },
        () => {},
      );
    });
  }

  function downscale(file) {
    return new Promise((resolve, reject) => {
      const src = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(src);
        const scale = Math.min(1, PHOTO_MAX / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", PHOTO_QUALITY);
      };
      img.onerror = () => {
        URL.revokeObjectURL(src);
        reject(new Error("decode failed"));
      };
      img.src = src;
    });
  }

  // Views. Every user string passes through e() exactly once, at the point it enters markup.
  const planById = (id) => state.plans.find((p) => p.id === id);

  function planCard(p) {
    const t = PLAN_TYPES[p.type];
    return `<article class="plan-card"><div class="plan-cover ${t.cover}"><span class="cover-tag">${e(t.label)}</span><span aria-hidden="true">${e(p.emoji)}</span></div><div class="plan-content"><h3 class="plan-title"><button class="plan-open" data-action="open-plan" data-id="${e(p.id)}">${e(p.title)}</button></h3><p class="plan-desc">${e(p.desc || "A plan waiting to unfold.")}</p><div class="plan-meta"><span class="date">📅 ${e(fmtDate(p.date))}</span><span>📍 ${e(p.place || "Location TBD")}</span></div></div></article>`;
  }

  function planGrid(plans, emptyMsg) {
    return `<section class="plans">${plans.length ? plans.map(planCard).join("") : `<div class="empty">${e(emptyMsg)}</div>`}</section>`;
  }

  function timelineItem(p) {
    const d = localDate(p.date);
    const t = PLAN_TYPES[p.type];
    return `<button class="timeline-item" data-action="open-plan" data-id="${e(p.id)}"><span class="datebox"><b>${d.getDate()}</b><small>${e(d.toLocaleDateString(undefined, { month: "short" }).toUpperCase())}</small></span><span class="timeline-text"><b>${e(p.title)}</b><span>${e(p.place || "Location TBD")} · ${e(t.label)}</span></span></button>`;
  }

  function taskLine(t) {
    return `<div class="checkline ${t.done ? "done" : ""}"><label><input type="checkbox" data-action="toggle-task" data-id="${e(t.id)}" ${t.done ? "checked" : ""}><span>${e(t.text)}</span></label><button class="task-del" data-action="delete-task" data-id="${e(t.id)}" aria-label="Delete ${e(t.text)}">×</button></div>`;
  }

  function taskBlock(planId) {
    const tasks = L.tasksFor(state, planId);
    return `<div class="checklist">${tasks.length ? tasks.map(taskLine).join("") : `<p class="muted">Nothing here yet.</p>`}</div><form class="add-task" data-action="add-task" data-plan-id="${e(planId ?? "")}"><input name="text" data-draft="task:${e(planId ?? "")}" value="${e(draft(`task:${planId ?? ""}`))}" aria-label="Add a checklist item" placeholder="Add a reminder..." autocomplete="off"><button class="button" type="submit">Add</button></form>`;
  }

  const progressText = (tasks) => {
    const { done, total } = L.progress(tasks);
    return `${done} of ${total} done`;
  };

  function memoryCard(m, deletable) {
    const media = m.hasPhoto
      ? `<div class="memory-media" data-photo="${e(m.id)}" data-alt="${e(`Photo for ${m.title || "a little memory"}`)}"><div class="memory-image placeholder">♡</div></div>`
      : `<div class="memory-image placeholder">♡</div>`;
    const tags = m.tags.length ? `<div class="memory-tags">${m.tags.map((t) => `<span class="memory-tag">#${e(t)}</span>`).join("")}</div>` : "";
    return `<article class="memory-card">${media}<div class="memory-body"><h3 class="memory-title">${e(m.title || "A little memory")}</h3><div class="memory-date">${e(fmtDate(m.date))}${m.mood ? ` · ${e(m.mood)}` : ""}</div><p class="memory-text">${e(m.text)}</p>${tags}${deletable ? `<button class="memory-delete" data-action="delete-memory" data-id="${e(m.id)}">Delete entry</button>` : ""}</div></article>`;
  }

  const memoryGrid = (memories, deletable) =>
    memories.length
      ? memories.map((m) => memoryCard(m, deletable)).join("")
      : `<div class="journal-empty">Your memories will show up here. Save your first little moment ✨</div>`;

  function filterChips() {
    const chip = (key, label) =>
      `<button class="filter ${ui.filter === key ? "active" : ""}" data-action="set-filter" data-filter="${key}" aria-pressed="${ui.filter === key}">${e(label)}</button>`;
    return `<div class="filters" role="group" aria-label="Filter plans">${chip("all", "All plans")}${Object.entries(PLAN_TYPES).map(([k, t]) => chip(k, t.filter)).join("")}</div>`;
  }

  const MOODS = ["Happy ☀️", "Excited ✨", "Peaceful 🌿", "Grateful ♡", "Silly 😄", "Adventurous 🗺️", "Cozy ☁️"];

  function journalForm(today) {
    const mood = draft("journal:mood");
    const photo = draft("journal:photo", null);
    return `<div class="journal-form-panel"><h3>Save a memory ♡</h3><p>Photos, little moments, thoughts, and stories.</p><form data-action="save-memory"><div class="journal-fields">
<label class="sr-only" for="memoryTitle">Memory title</label><input id="memoryTitle" name="title" data-draft="journal:title" value="${e(draft("journal:title"))}" placeholder="Memory title (optional)">
<label class="sr-only" for="memoryDate">Date</label><input id="memoryDate" name="date" type="date" data-draft="journal:date" value="${e(draft("journal:date", today))}">
<label class="sr-only" for="memoryMood">Mood</label><select id="memoryMood" name="mood" data-draft="journal:mood"><option value="">Choose a mood (optional)</option>${MOODS.map((o) => `<option ${o === mood ? "selected" : ""}>${e(o)}</option>`).join("")}</select>
<label class="sr-only" for="memoryText">What happened</label><textarea id="memoryText" name="text" data-draft="journal:text" placeholder="Write about your day, what happened, what you loved, or anything you want to remember...">${e(draft("journal:text"))}</textarea>
<label class="sr-only" for="memoryTags">Tags</label><input id="memoryTags" name="tags" data-draft="journal:tags" value="${e(draft("journal:tags"))}" placeholder="Tags (separate with commas)">
<label class="photo-pick">📷 Add a photo <input type="file" id="memoryPhoto" accept="image/*" data-action="pick-photo"></label>
<img class="photo-preview" id="memoryPreview" alt="Selected memory photo preview"${photo ? ` src="${photo.url}" style="display:block"` : ""}>
</div><p class="form-note" id="journalMsg" role="status"></p><button class="button" type="submit">Save Memory ♡</button></form></div>`;
  }

  const VIEWS = {
    home(today) {
      const s = L.stats(state, today);
      const shown = L.filterPlans(state, { query: ui.query }).slice(0, 3);
      const coming = L.upcomingPlans(state, today).slice(0, 4);
      const tile = (label, emoji, n, caption) =>
        `<div class="stat"><div class="stat-top">${label} <span class="stat-emoji" aria-hidden="true">${emoji}</span></div><div class="stat-number">${n}</div><div class="stat-caption">${caption}</div></div>`;
      return `<section class="hero"><div><h2>Make your next memory ✨</h2><p>Whether it's a weekend getaway, a birthday, or a spontaneous adventure—start planning something wonderful.</p><div class="hero-actions"><button class="button" data-action="new-plan">＋ Create a plan</button><button class="button secondary" data-action="nav" data-route="journal">♡ Write a memory</button></div></div><div class="hero-art" aria-hidden="true">🗺️</div></section>
<section class="stats">${tile("Plans in progress", "🗂️", s.plans, "things you're looking forward to")}${tile("Upcoming plans", "📅", s.upcoming, "on your calendar")}${tile("Checklist items", "☑️", s.openTasks, "little things to remember")}</section>
<div class="section-head"><h2>My plans</h2><a href="#/plans">View all →</a></div>
${planGrid(shown, ui.query ? "No plans match your search." : "No plans here yet. Add something fun to look forward to! ✨")}
<section class="journal-section"><div class="section-head"><h2>My Journal ✧</h2><a href="#/journal">View all →</a></div><div class="journal-board"><div class="journal-grid">${memoryGrid(state.memories.slice(0, 2), false)}</div></div></section>
<div class="bottom-grid"><section class="widget"><h3>Coming up ✧</h3><div class="timeline">${coming.length ? coming.map(timelineItem).join("") : `<p class="muted">Add a dated plan to see it here.</p>`}</div></section>
<section class="widget"><h3>Quick checklist ☑</h3>${taskBlock(null)}</section></div>`;
    },

    plans() {
      const shown = L.filterPlans(state, { type: ui.filter, query: ui.query });
      const filtered = ui.filter !== "all" || ui.query.trim() !== "";
      return `<div class="section-head"><h2>My plans</h2><button class="button" data-action="new-plan">＋ New plan</button></div>${filterChips()}<div style="height:15px"></div>${planGrid(shown, filtered ? "No plans match. Try another filter or search." : "No plans here yet. Add something fun to look forward to! ✨")}`;
    },

    calendar(today) {
      const { year, month } = ui.calendarCursor;
      const byDate = L.plansByDate(state);
      const monthTitle = new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
      const names = [0, 1, 2, 3, 4, 5, 6].map((i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: "short" }));
      const cell = (c) => {
        const plans = byDate[c.date] || [];
        const label = `Add a plan on ${fmtDate(c.date)}`;
        const chips = plans
          .map((p) => `<button class="cal-chip ${PLAN_TYPES[p.type].cover}" data-action="open-plan" data-id="${e(p.id)}" title="${e(p.title)}" aria-label="${e(p.title)}"><span aria-hidden="true">${e(p.emoji)}</span><span class="t">${e(p.title)}</span></button>`)
          .join("");
        const cls = ["cal-cell", c.inMonth ? "" : "out", c.date === today ? "today" : "", plans.length ? "" : "blank"].join(" ");
        const hit = plans.length ? "" : ` data-action="new-plan-on" data-date="${c.date}"`;
        return `<div class="${cls}"${hit}><button class="cal-day" data-action="new-plan-on" data-date="${c.date}" aria-label="${e(label)}">${c.day}</button><div class="cal-chips">${chips}</div></div>`;
      };
      const monthPlans = L.plansInMonth(state, year, month);
      return `<div class="section-head"><h2>${e(monthTitle)}</h2><div class="cal-controls"><button class="button secondary" data-action="cal-prev" aria-label="Previous month">‹</button><button class="button secondary" data-action="cal-today">Today</button><button class="button secondary" data-action="cal-next" aria-label="Next month">›</button></div></div>
<div class="calendar"><div class="cal-head">${names.map((n) => `<div>${e(n.toUpperCase())}</div>`).join("")}</div><div class="cal-grid">${L.monthGrid(year, month).flat().map(cell).join("")}</div></div>
<section class="widget cal-list"><h3>Plans this month</h3><div class="timeline">${monthPlans.length ? monthPlans.map(timelineItem).join("") : `<p class="muted">Nothing planned this month.</p>`}</div></section>`;
    },

    journal(today) {
      return `<div class="section-head"><h2>My Journal ✧</h2></div><div class="journal-layout"><div class="journal-board"><div class="journal-grid">${memoryGrid(state.memories, true)}</div></div>${journalForm(today)}</div>`;
    },

    checklists() {
      const general = L.tasksFor(state, null);
      const planCards = state.plans
        .map((p) => ({ p, tasks: L.tasksFor(state, p.id) }))
        .filter(({ tasks }) => tasks.length)
        .map(({ p, tasks }) => `<section class="widget"><h3><button class="link-title" data-action="open-plan" data-id="${e(p.id)}">${e(p.emoji)} ${e(p.title)}</button><span class="progress">${progressText(tasks)}</span></h3>${taskBlock(p.id)}</section>`)
        .join("");
      return `<div class="cards-2"><section class="widget"><h3>General ☑<span class="progress">${progressText(general)}</span></h3>${taskBlock(null)}</section>${planCards}</div>`;
    },
  };

  const modalShell = (title, body) =>
    `<div class="modal-backdrop open" data-action="backdrop"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-head"><h2 id="modalTitle">${e(title)}</h2><button class="close" data-action="close-modal" aria-label="Close">×</button></div>${body}</div></div>`;

  const MODALS = {
    "plan-detail"(m, today) {
      const p = planById(m.id);
      const t = PLAN_TYPES[p.type];
      const tasks = L.tasksFor(state, p.id);
      const when = p.date ? `📅 <b>${e(fmtDate(p.date))}</b> · ${e(L.countdownLabel(p.date, today))}` : "📅 Date TBD";
      const actions = m.confirming
        ? `<p class="confirm-text">Delete this plan${tasks.length ? ` and its ${tasks.length} checklist item${tasks.length === 1 ? "" : "s"}` : ""}?</p><button class="button secondary" data-action="cancel-delete">Keep it</button><button class="button danger" data-action="delete-plan" data-id="${e(p.id)}">Yes, delete</button>`
        : `<button class="button secondary" data-action="ask-delete">Delete</button><button class="button" data-action="edit-plan" data-id="${e(p.id)}">Edit</button>`;
      return modalShell(p.title, `<div class="plan-cover ${t.cover}"><span class="cover-tag">${e(t.label)}</span><span aria-hidden="true">${e(p.emoji)}</span></div>
<p class="detail-line">${when}</p><p class="detail-line">📍 ${e(p.place || "Location TBD")}</p>${p.desc ? `<p class="detail-notes">${e(p.desc)}</p>` : ""}
<h3>Checklist ☑${tasks.length ? `<span class="progress">${progressText(tasks)}</span>` : ""}</h3>${taskBlock(p.id)}<div class="modal-actions">${actions}</div>`);
    },

    "plan-form"(m) {
      const p = m.id ? planById(m.id) : null;
      const base = p || { title: "", type: "trip", date: m.presetDate || "", place: "", desc: "", emoji: PLAN_TYPES.trip.emoji };
      const v = Object.fromEntries(["title", "type", "date", "place", "desc", "emoji"].map((k) => [k, draft(`modal:${k}`, base[k])]));
      const emojis = [...new Set([...L.EMOJI_CHOICES, v.emoji])];
      return modalShell(p ? "Edit plan" : "Create a new plan", `<form data-action="save-plan" data-id="${e(m.id || "")}">
<div class="field"><label for="planName">What are you planning?</label><input id="planName" name="title" data-draft="modal:title" autofocus required placeholder="e.g. Beach weekend, Birthday dinner" value="${e(v.title)}"></div>
<div class="field"><label for="planType">Type</label><select id="planType" name="type" data-draft="modal:type" data-action="plan-type" data-prev="${v.type}">${Object.entries(PLAN_TYPES).map(([k, t]) => `<option value="${k}" ${k === v.type ? "selected" : ""}>${e(t.formLabel)}</option>`).join("")}</select></div>
<div class="form-row"><div class="field"><label for="planDate">Date</label><input id="planDate" name="date" type="date" data-draft="modal:date" value="${e(v.date)}"></div><div class="field"><label for="planPlace">Location</label><input id="planPlace" name="place" data-draft="modal:place" placeholder="Where?" value="${e(v.place)}"></div></div>
<div class="field"><label for="planDesc">Notes</label><textarea id="planDesc" name="desc" data-draft="modal:desc" placeholder="Ideas, details, who is coming...">${e(v.desc)}</textarea></div>
<div class="field" role="group" aria-labelledby="emojiLabel"><span class="label" id="emojiLabel">Emoji</span><input type="hidden" name="emoji" value="${e(v.emoji)}"><div class="emoji-row">${emojis.map((em) => `<button type="button" class="emoji-btn" data-action="pick-emoji" data-emoji="${e(em)}" aria-pressed="${em === v.emoji}" aria-label="Emoji ${e(em)}">${e(em)}</button>`).join("")}</div></div>
<p class="form-error" id="formError" role="alert"></p>
<div class="modal-actions"><button type="button" class="button secondary" data-action="close-modal">Cancel</button><button class="button" type="submit">Save plan</button></div></form>`);
    },
  };

  // Focus bookkeeping. A selector plus index finds "the same" control after innerHTML replaces it.
  function describe(el) {
    if (!el || el === document.body) return null;
    const attrs = el.getAttributeNames().filter((n) => n === "id" || n.startsWith("data-"));
    if (!attrs.length) return null;
    const sel = el.localName + attrs.map((n) => `[${n}="${CSS.escape(el.getAttribute(n))}"]`).join("");
    return { sel, idx: [...document.querySelectorAll(sel)].indexOf(el) };
  }
  const resolve = (d) => (d ? document.querySelectorAll(d.sel)[Math.max(d.idx, 0)] : null);

  let lastActionEl = null;
  let triggerDesc = null;
  let shownModalKey = "";

  function render() {
    const before = describe(document.activeElement);
    const m = ui.modal;
    if (m && (m.kind === "plan-detail" || m.id) && !planById(m.id)) ui.modal = null;
    const key = ui.modal ? ui.modal.kind + (ui.modal.id || "") : "";
    if (key !== shownModalKey) dropDrafts("modal:");
    const today = todayKey();
    const route = ROUTES[ui.route];

    $("nav").innerHTML = Object.entries(ROUTES)
      .map(([k, r]) => `<button class="${k === ui.route ? "active" : ""}" data-action="nav" data-route="${k}" ${k === ui.route ? 'aria-current="page"' : ""}><span class="nav-icon" aria-hidden="true">${r.icon}</span>${e(r.label)}</button>`)
      .join("");
    $("welcome").innerHTML = `<h1>${e(route.title)}</h1><p>${e(route.sub)}</p>`;
    $("view").innerHTML = VIEWS[ui.route](today);
    $("modalRoot").innerHTML = ui.modal ? MODALS[ui.modal.kind](ui.modal, today) : "";
    hydratePhotos();

    if (key !== shownModalKey) {
      if (ui.modal) {
        if (!shownModalKey) triggerDesc = describe(lastActionEl);
        const first = $("modalRoot").querySelector("[autofocus]") || $("modalRoot").querySelector(".close");
        if (first) first.focus();
      } else {
        const back = resolve(triggerDesc);
        if (back) back.focus();
      }
      shownModalKey = key;
    } else if (document.activeElement === document.body) {
      const again = resolve(before);
      if (again) again.focus();
    }
  }

  function routeFromHash() {
    const name = location.hash.replace(/^#\//, "");
    return Object.hasOwn(ROUTES, name) ? name : "home";
  }

  function syncRoute() {
    const name = routeFromHash();
    if (location.hash !== `#/${name}`) {
      try {
        history.replaceState(null, "", `#/${name}`);
      } catch (err) {
        location.hash = `#/${name}`;
      }
    }
    ui.route = name;
    ui.modal = null;
  }

  const openModal = (modal) => { ui.modal = modal; render(); };
  const closeModal = () => { ui.modal = null; render(); };

  function setEmoji(form, emoji) {
    form.elements.emoji.value = emoji;
    ui.drafts["modal:emoji"] = emoji;
    form.querySelectorAll(".emoji-btn").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.emoji === emoji)));
  }

  async function savePhotoPick(input) {
    const msg = $("journalMsg");
    const file = input.files[0];
    if (!file) return;
    msg.textContent = "";
    if (!file.type.startsWith("image/")) {
      input.value = "";
      msg.textContent = "Please choose an image file.";
      return;
    }
    try {
      const blob = await downscale(file);
      const old = draft("journal:photo", null);
      if (old) URL.revokeObjectURL(old.url);
      ui.drafts["journal:photo"] = { blob, url: URL.createObjectURL(blob) };
      render();
    } catch (err) {
      msg.textContent = "That image couldn't be read. Try a different one.";
    }
  }

  async function saveMemory(form) {
    const msg = $("journalMsg");
    const submit = form.querySelector('button[type="submit"]');
    const f = new FormData(form);
    const photo = draft("journal:photo", null);
    const fields = { title: f.get("title"), date: f.get("date"), mood: f.get("mood"), text: f.get("text"), tags: L.parseTags(f.get("tags")), hasPhoto: photo !== null };
    if (!L.canSaveMemory(fields)) {
      msg.textContent = "Add a title, some writing, or a photo to save a memory.";
      return;
    }
    const id = uid();
    let note = "";
    submit.disabled = true;
    if (photo) {
      try {
        await putPhoto(id, photo.blob);
      } catch (err) {
        fields.hasPhoto = false;
        note = " The photo couldn't be stored in this browser, so it was left out.";
      }
    }
    submit.disabled = false;
    if (!L.canSaveMemory(fields)) {
      msg.textContent = "This browser can't store photos right now. Add a title or some writing to save the memory without it.";
      return;
    }
    const saved = commit(L.addMemory(state, fields, id), () => {
      if (photo) URL.revokeObjectURL(photo.url);
      dropDrafts("journal:");
      toast(`Memory saved ♡${note}`);
    });
    if (!saved && fields.hasPhoto) removePhoto(id).catch(() => {});
  }

  function savePlan(form) {
    const f = new FormData(form);
    const fields = { title: f.get("title"), type: f.get("type"), date: f.get("date"), place: f.get("place"), desc: f.get("desc"), emoji: f.get("emoji") };
    if (!fields.title.trim()) {
      $("formError").textContent = "Give your plan a name.";
      return;
    }
    const id = form.dataset.id;
    commit(id ? L.updatePlan(state, id, fields) : L.addPlan(state, fields, uid()), () => {
      ui.modal = null;
      toast("Plan saved ✨");
    });
  }

  const HANDLERS = {
    click: {
      nav: (el) => { location.hash = `#/${el.dataset.route}`; },
      "new-plan": () => openModal({ kind: "plan-form", id: null }),
      "new-plan-on": (el) => openModal({ kind: "plan-form", id: null, presetDate: el.dataset.date }),
      "open-plan": (el) => openModal({ kind: "plan-detail", id: el.dataset.id }),
      "edit-plan": (el) => openModal({ kind: "plan-form", id: el.dataset.id }),
      "ask-delete": () => {
        openModal({ ...ui.modal, confirming: true });
        $("modalRoot").querySelector('[data-action="delete-plan"]').focus();
      },
      "cancel-delete": () => {
        openModal({ kind: "plan-detail", id: ui.modal.id });
        $("modalRoot").querySelector('[data-action="ask-delete"]').focus();
      },
      "delete-plan": (el) => commit(L.deletePlan(state, el.dataset.id), () => {
        ui.modal = null;
        toast("Plan deleted");
      }),
      "close-modal": closeModal,
      backdrop: (el, ev) => { if (ev.target === el && pressTarget === el) closeModal(); },
      "set-filter": (el) => { ui.filter = el.dataset.filter; render(); },
      "pick-emoji": (el) => setEmoji(el.closest("form"), el.dataset.emoji),
      "cal-prev": () => { ui.calendarCursor = L.shiftMonth(ui.calendarCursor, -1); render(); },
      "cal-next": () => { ui.calendarCursor = L.shiftMonth(ui.calendarCursor, 1); render(); },
      "cal-today": () => { const d = new Date(); ui.calendarCursor = { year: d.getFullYear(), month: d.getMonth() }; render(); },
      "delete-task": (el) => commit(L.deleteTask(state, el.dataset.id)),
      "delete-memory": (el) => {
        const id = el.dataset.id;
        commit(L.deleteMemory(state, id), () => {
          forgetPhoto(id);
          toast("Memory deleted");
        });
      },
    },
    change: {
      "toggle-task": (el) => commit(L.toggleTask(state, el.dataset.id)),
      "pick-photo": (el) => savePhotoPick(el),
      "plan-type": (el) => {
        const form = el.form;
        if (form.elements.emoji.value === PLAN_TYPES[el.dataset.prev].emoji) setEmoji(form, PLAN_TYPES[el.value].emoji);
        el.dataset.prev = el.value;
      },
    },
    submit: {
      "save-plan": (form) => savePlan(form),
      "save-memory": (form) => saveMemory(form),
      "add-task": (form) => {
        const text = new FormData(form).get("text");
        const next = L.addTask(state, { text, planId: form.dataset.planId || null }, uid());
        if (next !== state) commit(next, () => delete ui.drafts[form.elements.text.dataset.draft]);
      },
    },
  };

  let pressTarget = null;
  document.addEventListener("pointerdown", (ev) => { pressTarget = ev.target; });

  const CONFIRM_ACTIONS = new Set(["delete-plan", "cancel-delete"]);

  function dispatch(type, ev) {
    const el = ev.target.closest("[data-action]");
    const handler = el && HANDLERS[type][el.dataset.action];
    if (!handler) return;
    if (type === "click") lastActionEl = el;
    if (type === "submit") ev.preventDefault();
    if (ui.modal?.confirming && el.closest(".modal") && !CONFIRM_ACTIONS.has(el.dataset.action)) {
      ui.modal = { ...ui.modal, confirming: false };
      render();
    }
    handler(el, ev);
  }

  document.addEventListener("click", (ev) => dispatch("click", ev));
  document.addEventListener("change", (ev) => dispatch("change", ev));
  document.addEventListener("submit", (ev) => dispatch("submit", ev));
  document.addEventListener("input", (ev) => { const k = ev.target.dataset.draft; if (k) ui.drafts[k] = ev.target.value; });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && ui.modal) closeModal(); });

  $("search").addEventListener("input", (ev) => {
    ui.query = ev.target.value;
    if (ui.route === "home" || ui.route === "plans") render();
    else location.hash = "#/plans";
  });

  window.addEventListener("hashchange", () => {
    syncRoute();
    window.scrollTo(0, 0);
    render();
  });

  syncRoute();
  render();
})();
