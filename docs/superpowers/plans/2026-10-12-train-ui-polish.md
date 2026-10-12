# Train screen UI polish (compact, simple, readable) — design and plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Extends** [2026-10-08-train-workspace-design.md](../specs/2026-10-08-train-workspace-design.md), whose "Screen" section it supersedes where they differ (the left rail and the three stacked tab strips are removed). Behaviour, URL state (`dataset`, `tab`, `run`, `view`, `compare`, `cmp`) and every data flow stay as built in Plans 1–3.

## Why

Snapshots of the real screen at idle, form, run starting, run in progress (log) and run finished showed: six stacked chrome layers before any data (app header, "Train", the single-tab "YOLO" strip, the run strip, Runs/New run tabs, the run breadcrumb, Overview/Metrics/Log/Model tabs: the first data starts at ~390 of 1080 px); no visible primary action ("New run" is a tab; Start is at the bottom of a long scroll); duplicates (progress in the strip and in Overview, a dataset card repeating the dataset select and listing classes with zero examples, "What will run" repeating the form); an Overview that opens with 30 mostly-default configuration rows while the results are below the fold; a single 770 px form column next to an empty half screen with a paragraph of help under every field; a table with an empty Name column, a permanently disabled Compare button, three buttons per row and white native checkboxes on the dark theme; lots of small gray-500/600 text; a log that opens with 23 lines of model architecture.

## Design (decided with the user: full-width, no left column)

1. **One toolbar** replaces the title, the family tab strip, the left rail and the Runs/New run tab strip: `Train · [Dataset ▾ 009 · detection · 110 frames]  [summary: 105 polyp · train 62 / val 24 / test 24]  ·····  [+ New run]`. The dataset summary is one line; "classes" opens the class list (only classes with at least one example; "+N classes without examples" as a muted line). When the form is open the primary button becomes `← Runs`. The `tab=new` URL still opens the form; there are no tab buttons.
2. **Active-run strip** stays on top of every view, one compact row: `▶ #458 ui-snapshot · epoch 2/3 · mAP50 0.03 [thin progress bar inside] [Stop]`. Progress is shown nowhere else.
3. **Runs list:** columns `☐ · # (name beneath, note as a title tooltip) · Base · Settings · Status · Score · Duration · Created · ⋯`. Clicking a row opens it (no Open button); actions: a secondary text button "Repeat" and a `⋯` menu with "Delete" (arm/confirm inside the menu; disabled with its reason). No Name column. The compare bar appears only when at least one row is ticked: `N selected · [Compare] · Clear`. Checkboxes use the dark colour scheme (`accent-blue-500` + `[color-scheme:dark]`).
4. **Run page:** one header row `← Runs · #id name (click to rename) · status · headline metric (large) · duration · [Repeat] [⋯]`; below it a one-line note (click to edit); sub-tabs Overview / Metrics / Log / Model stay. **Overview** = result cards (precision, recall, mAP50, mAP50-95, fitness as compact cards with 3-decimal numbers), the training curve, then "Changed settings" (only non-default values, each with its default) and a `<details>` "All settings (N)" (collapsed). No progress block (the strip owns it).
5. **New run form:** two columns from `lg` up — left (≈ 22 rem): base model, run name, note, presets as a segmented row; right: the settings groups, fields in a 3-column grid (2 below `xl`), the one-line help moved into a `title`/info tooltip and `aria-describedby` (still announced, not printed), range shown inline with the label. A compact sticky bottom bar: `N changes (expandable list) · [Start training]`. The separate "What will run" card goes away.
6. **Type and spacing:** body 14 px; secondary text 13 px `text-gray-400` (never gray-500/600 for text that must be read); section headings 15 px semibold; page padding `px-6`; one spacing scale (4/8/12/16/24); controls 32 px high; no all-caps micro labels except table headers.
7. **Log:** the model-architecture preamble (from the `from  n  params  module  arguments` header through the `YOLO11n summary:` line) folds into one `<details>` "Model architecture (N lines)", collapsed; the log pane height is capped at `60vh`.
8. **Compare view and all other Train components** adopt the same type scale and header style (no behaviour change).

## Global constraints

Work on `master` (no branches). English UI copy. Dark theme only. All HTTP via `apiClient`. TDD (update existing tests to the new structure — behaviour assertions stay, structure queries change). Checks: `cd frontend && npx vitest run src/features/training` and `npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -v TS2339 | grep features/training` (must print nothing; page tests can flake under load — rerun alone). Do not start/stop servers or touch DBs. Commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; `git add` only your own files (teammates edit other files in parallel); never commit the untracked `yolo_qc_playground_architecture.pdf` or any PNG.

## Tasks

### Task 1: Toolbar, frame and strip (`TrainPage.tsx`, new `TrainToolbar.tsx`, `DatasetSummary.tsx`, `ActiveRunStrip.tsx`; delete `DatasetRail.tsx`, `DatasetCard.tsx`)
- Remove the title, the YOLO tab strip, the rail and the Runs/New-run tab buttons (keep `role="tabpanel"` semantics only where a real tab remains: the run page's sub-tabs). `TrainToolbar({ datasets, selectedId, onSelect, runCount, onNewRun, formOpen, onCloseForm })` with the select, `DatasetSummary` (one line + class popover via `<details>`; classes with 0 examples hidden behind "+N without examples") and the primary button (`+ New run` / `← Runs`). The not-exported warning stays (disabled option + reason).
- `ActiveRunStrip` one compact row with the progress bar inside; no duplicate progress in details.
- Keep all URL behaviours (`tab=new` opens the form, one patch per interaction), the stale guards, preselect, prefill, compare wiring. The page layout: `px-6 py-4`, full width, normal scroll.
- Tests: update `TrainPage.test.tsx`, `ActiveRunStrip.test.tsx`; new tests for the toolbar (select, summary text, class list hides zero-example classes, "+ New run" ↔ "← Runs", disabled button without a dataset) and `DatasetSummary`.

### Task 2: Runs list (`RunsTable.tsx`)
Implement design point 3: row click opens; "Repeat" button + `⋯` menu (Delete with arm/confirm and disabled reasons, keyboard operable: `aria-haspopup`, Escape closes, focus returns); name under the id; the compare bar only with ≥1 tick (`N selected · Compare · Clear`, Compare needs ≥2); dark checkboxes; 14/13 px type scale; keep best-run emphasis, aria-labels with run ids ("Select run N for comparison", "Delete run N", "Repeat run N with changes"), `aria-current`, horizontal scroll container, empty/loading/error states. Update `RunsTable.test.tsx` and the page tests that clicked "Open".

### Task 3: Run page header and Overview (`RunDetail.tsx`, `RunOverview.tsx`, `RunMetricsView.tsx` styling)
Implement design point 4 (header row, one-line editable name and note keeping the save-on-blur/Escape/failed-PATCH behaviour, metric cards, curve, changed settings + collapsed "All settings (N)", no progress block, actions `Repeat` + `⋯` with Delete run arm/confirm). Hide groups with no recorded keys (already done) in "All settings". Update `RunOverview.test.tsx`, `RunDetail.test.tsx`.

### Task 4: New run form (`TrainConfigForm.tsx`, `SettingsForm.tsx`, `RunSummary.tsx` → compact bar)
Implement design point 5: two-column layout, fields in a grid, help as tooltip + `aria-describedby` (not printed), inline range, presets as a segmented control, sticky compact bottom bar `N changes (expandable) · Start training` (reason line "N settings need attention" kept, groups with errors auto-open kept). Update `TrainConfigForm.test.tsx`, `SettingsForm.test.tsx`, `RunSummary.test.tsx` (or its replacement).

### Task 5: Type scale, log folding, compare view style
Apply design points 6–8: shared Tailwind class constants or small components for headings/labels/secondary text (a `ui.ts` of class strings is enough), replace gray-500/600 text on dark with gray-400, 14/13 px scale, page padding; `cleanLog` + `LogView` fold the model-architecture block into a collapsed `<details>` (tests with a real excerpt: header line `from  n    params  module    arguments` … `YOLO11n summary:`), log pane `max-h-[60vh]`; restyle `CompareView`/`CompareTables`/`CompareCurves`/`ConfusionCompare` headings and spacing only.

### Task 6: Live verification (controller)
Re-take the five snapshots (idle list, form, run starting, run in progress incl. Log, run finished incl. Metrics) plus the compare view at 1920×1080 and 900 px and compare against the "Why" list; fix what is still unclear; ROADMAP entry; clean up any run created (model, run, job, MinIO prefix; counts must match the recorded 4/1/7, maxjob 2198 plus the one snapshot run 458 which is removed at the end).
