# Daydream

A personal planner that runs entirely in your browser: plans, a month calendar, a journal with photos, and checklists. No server, no build, no dependencies.

## Open it

Double-click `index.html` (it works from `file://`), or serve the folder with any static server, for example `python3 -m http.server`.

## Test it

```
node --test tests/
node --check app.js logic.js
node scripts/e2e.js   # optional: drives the real page in headless Google Chrome
```

`tests/` covers the pure functions in `logic.js`. `scripts/e2e.js` needs Chrome (set `CHROME` to its path if it is not in the default macOS location).

## Where your data lives

- Plans, checklist items and journal text: `localStorage`, key `daydream.v1`, in this browser only.
- Journal photos: IndexedDB, database `daydream`, store `photos`, keyed by memory id. Photos are downscaled to 1000px JPEG first.

Clearing site data for the page erases everything. There is no sync between browsers or devices.

## Layout

- `logic.js`: pure state transitions, date math and the plan type table. No DOM, no storage.
- `app.js`: storage, hash routing (`#/home`, `#/plans`, `#/calendar`, `#/journal`, `#/checklists`), rendering and event wiring.
- `index.html`: markup and CSS.
