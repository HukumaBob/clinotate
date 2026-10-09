# Train Workspace, Plan 3 of 3: Compare — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compare two or three runs of one dataset side by side: configuration differences, overlaid training curves, final metrics with deltas, per-class metrics, and confusion matrices (with a difference matrix for two runs).

**Architecture:** Frontend only; every number already exists on the run (`GET /training/runs/{id}/metrics`). A pure `compareLogic.ts` turns the runs' metrics into table/series data; small presentational components render it; the runs table gains selection checkboxes and a "Compare" button; the selected ids live in the URL (`compare=268,406`) and replace the table with the compare view.

**Tech Stack:** React, react-router-dom, vitest, plain SVG (no chart library; the repo's `MetricsChart` is also hand-drawn).

**Spec:** [docs/superpowers/specs/2026-10-08-train-workspace-design.md](../specs/2026-10-08-train-workspace-design.md) — "Compare" (two or three runs of one dataset; configuration differences only; overlaid curves with a metric selector, default the headline metric; final-metrics table with best emphasised and delta against the first; per-class table run × class with deltas; confusion matrices side by side and, for exactly two runs, a "difference B − A" toggle; tables from the union of metric keys, never a hardcoded vocabulary; a short caption per section). Plans 1 and 2 are done.

## Global Constraints

- Work directly on `master`; no branches/worktrees (CLAUDE.md). Untracked `yolo_qc_playground_architecture.pdf` and any `*.png` in the repo root are never committed.
- English only (code, comments, UI copy, commits). Dark theme only (no light-background Tailwind classes).
- TDD: a failing test before every implementation step. All HTTP via `apiClient`; never hand-edit `frontend/src/shared/api/generated/`. No backend change in this plan.
- Checks after each task: `cd frontend && npx vitest run src/features/training` and `npx tsc -p tsconfig.app.json --noEmit 2>&1 | grep -v TS2339 | grep features/training` (must print nothing). Do NOT start/stop dev servers or touch ports 5173/5174/8000 without approval. Known pre-existing noise: jest-dom `TS2339` matcher errors, a `qc/RunStatus.test.tsx` TS2739.
- Comparison is only ever between runs of the SAME dataset (same validation split and classes): the compare view is reachable only from the selected dataset's table and the URL keeps only ids that belong to it.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Token economy (user request): per-task review by one reviewer on `sonnet`; skip a separate re-review for tiny fixes; one whole-plan review at the end.

## Review Focus

1. Never compare numbers across vocabularies silently: a metric a run does not report shows "—" (not 0), and "best" is only marked when at least two runs report it and they are not all equal. Loss-like keys (`loss` in the name) are better when LOWER; everything else when higher.
2. Deltas are always against the FIRST selected run; the first run's own delta cell is empty.
3. Runs with no history, no per-class numbers or no confusion matrix (older runs) show explicit empty states per section, never a crash or a blank section.
4. The confusion difference is B − A over labels both runs have (aligned by label name, not by index); it is offered only for exactly two runs; when no labels overlap it says so.
5. The selection in the table is capped at 3; a 4th checkbox is disabled with a reason; "Compare" needs at least 2.
6. The URL is the source of truth: `compare=` is parsed defensively (positive ints, unique, max 3, others dropped), survives reload, and ids not belonging to the dataset's runs are dropped with a visible note; fewer than 2 valid ids falls back to the table.
7. Stale answers: switching the selection or dataset quickly never shows another selection's metrics (request counter).
8. The whole view scrolls with the page; wide tables scroll horizontally inside their own container; charts keep a minimum height.

## File Structure

All under `frontend/src/features/training/`:
- Create `compareLogic.ts`, `compareLogic.test.ts` — pure data shaping.
- Modify `useTrainUrl.ts` (+ test) — `compare: number[]`.
- Create `useCompareMetrics.ts` (+ test) — parallel metric loading for up to three runs.
- Modify `RunsTable.tsx` (+ test) — checkboxes, compare button.
- Create `CompareCurves.tsx`, `CompareTables.tsx`, `ConfusionCompare.tsx`, `CompareView.tsx` (+ tests).
- Modify `TrainPage.tsx` (+ test) — wiring.
- Modify `ROADMAP.md`.

---

### Task 1: Compare logic

**Files:** Create `compareLogic.ts`, `compareLogic.test.ts`.

**Interfaces (produces):**
```ts
export const MAX_COMPARE = 3;
export type Num = number | null;
export interface MetricRow { key: string; values: Num[]; bestIndex: number | null; deltas: Num[] }
export interface ConfigRow { key: string; label: string; values: string[] }
export interface CurvePoint { epoch: number; value: number }

export function runLabel(run: { id: number; name: string | null }): string;            // "#268" or "#268 big frames"
export function lowerIsBetter(key: string): boolean;                                    // key contains "loss"
export function bestAndDeltas(values: Num[], lowerBetter: boolean): { bestIndex: number | null; deltas: Num[] };
export function configDifferences(runs: RunLike[], schema: SettingsSchema | null): ConfigRow[];
export function finalMetricRows(metricsList: Array<Record<string, unknown> | null>): MetricRow[];
export function perClassColumns(sets: PerClassRow[][]): string[];
export function perClassRowsFor(sets: PerClassRow[][], column: string): Array<{ cls: string } & MetricRow>;
export function curveKeys(histories: HistoryPoint[][]): string[];
export function defaultCurveKey(keys: string[]): string | null;
export function curveSeries(history: HistoryPoint[], key: string): CurvePoint[];
export function confusionDifference(a: Confusion | null, b: Confusion | null): { labels: string[]; diff: number[][] } | null;
```
with `RunLike = { id: number; base_model: string; base_model_version_id?: number | null; config: Record<string, unknown> }`, `PerClassRow = Record<string, unknown>` (has `class`), `HistoryPoint = Record<string, number>` (has `epoch`), `Confusion = { labels: string[]; matrix: number[][] }`.

- [ ] **Step 1: Write the failing tests**

```ts
// compareLogic.test.ts
import { describe, expect, it } from "vitest";

import {
  bestAndDeltas,
  configDifferences,
  confusionDifference,
  curveKeys,
  curveSeries,
  defaultCurveKey,
  finalMetricRows,
  lowerIsBetter,
  perClassColumns,
  perClassRowsFor,
  runLabel,
} from "./compareLogic";
import { settingsSchemaFixture as schema } from "./testFixtures";

describe("labels and direction", () => {
  it("labels a run by id and name", () => {
    expect(runLabel({ id: 268, name: null })).toBe("#268");
    expect(runLabel({ id: 7, name: "big frames" })).toBe("#7 big frames");
  });

  it("treats loss-like keys as lower-is-better", () => {
    expect(lowerIsBetter("val/box_loss")).toBe(true);
    expect(lowerIsBetter("metrics/mAP50(B)")).toBe(false);
  });
});

describe("bestAndDeltas", () => {
  it("marks the highest value and deltas against the first", () => {
    const { bestIndex, deltas } = bestAndDeltas([0.5, 0.7, 0.6], false);

    expect(bestIndex).toBe(1);
    expect(deltas[0]).toBeNull();
    expect(deltas[1]).toBeCloseTo(0.2);
    expect(deltas[2]).toBeCloseTo(0.1);
  });

  it("marks the lowest value for a lower-is-better metric", () => {
    expect(bestAndDeltas([1.2, 0.8], true).bestIndex).toBe(1);
  });

  it("marks nothing when fewer than two runs report it or all are equal", () => {
    expect(bestAndDeltas([0.5, null], false).bestIndex).toBeNull();
    expect(bestAndDeltas([null, null], false).bestIndex).toBeNull();
    expect(bestAndDeltas([0.5, 0.5], false).bestIndex).toBeNull();
  });

  it("gives no delta when the first run lacks the value or the run itself lacks it", () => {
    expect(bestAndDeltas([null, 0.4, 0.6], false).deltas).toEqual([null, null, null]);
    expect(bestAndDeltas([0.4, null, 0.6], false).deltas[1]).toBeNull();
  });

  it("the first of equal best values wins", () => {
    expect(bestAndDeltas([0.7, 0.7, 0.2], false).bestIndex).toBe(0);
  });
});

describe("configDifferences", () => {
  const run = (id: number, config: Record<string, unknown>, base = "yolo11n.pt", version: number | null = null) => ({
    id,
    base_model: base,
    base_model_version_id: version,
    config,
  });

  it("lists only settings whose values differ, with schema labels", () => {
    const rows = configDifferences(
      [run(1, { epochs: 50, batch: 8 }), run(2, { epochs: 30, batch: 8 })],
      schema,
    );

    expect(rows).toEqual([{ key: "epochs", label: "Epochs", values: ["50", "30"] }]);
  });

  it("shows — for a setting one run does not have, and raw keys the schema does not know", () => {
    const rows = configDifferences([run(1, { epochs: 50, legacy: 1 }), run(2, { epochs: 50 })], schema);

    expect(rows).toEqual([{ key: "legacy", label: "legacy", values: ["1", "—"] }]);
  });

  it("starts with the base model row when bases differ, marking a fine-tune parent", () => {
    const rows = configDifferences(
      [run(1, {}, "yolo11n.pt"), run(2, {}, "parent-model", 9)],
      schema,
    );

    expect(rows[0]).toEqual({ key: "__base", label: "Base model", values: ["yolo11n.pt", "↳ parent-model"] });
  });

  it("is empty when nothing differs", () => {
    expect(configDifferences([run(1, { epochs: 5 }), run(2, { epochs: 5 })], schema)).toEqual([]);
  });
});

describe("finalMetricRows", () => {
  it("builds one row per numeric key in the union of the runs' metrics", () => {
    const rows = finalMetricRows([
      { "metrics/mAP50(B)": 0.5, fitness: 0.4, note: "x" },
      { "metrics/mAP50(B)": 0.7 },
    ]);

    expect(rows.map((r) => r.key).sort()).toEqual(["fitness", "metrics/mAP50(B)"]);
    const map = rows.find((r) => r.key === "metrics/mAP50(B)")!;
    expect(map.values).toEqual([0.5, 0.7]);
    expect(map.bestIndex).toBe(1);
    const fitness = rows.find((r) => r.key === "fitness")!;
    expect(fitness.values).toEqual([0.4, null]);
    expect(fitness.bestIndex).toBeNull();
  });

  it("treats a run without metrics as all-missing", () => {
    expect(finalMetricRows([null, { a: 1 }])[0].values).toEqual([null, 1]);
  });

  it("returns nothing when no run has numeric metrics", () => {
    expect(finalMetricRows([{}, null])).toEqual([]);
  });
});

describe("per-class", () => {
  const a = [{ class: "polyp", mAP50: 0.5, "Box-P": 0.6 }, { class: "feces", mAP50: 0.2 }];
  const b = [{ class: "polyp", mAP50: 0.7 }];

  it("lists numeric columns of the union of rows, first-seen order", () => {
    expect(perClassColumns([a, b])).toEqual(["mAP50", "Box-P"]);
  });

  it("builds class rows for one column with deltas against the first run", () => {
    const rows = perClassRowsFor([a, b], "mAP50");

    expect(rows.map((r) => r.cls)).toEqual(["polyp", "feces"]);
    expect(rows[0].values).toEqual([0.5, 0.7]);
    expect(rows[0].bestIndex).toBe(1);
    expect(rows[0].deltas[1]).toBeCloseTo(0.2);
    expect(rows[1].values).toEqual([0.2, null]);
  });

  it("copes with runs that have no per-class rows at all", () => {
    expect(perClassColumns([[], []])).toEqual([]);
    expect(perClassRowsFor([[], []], "mAP50")).toEqual([]);
  });
});

describe("curves", () => {
  const h1 = [
    { epoch: 1, "metrics/mAP50(B)": 0.1, "val/box_loss": 2 },
    { epoch: 2, "metrics/mAP50(B)": 0.3, "val/box_loss": 1.5 },
  ];
  const h2 = [{ epoch: 1, "metrics/mAP50(B)": 0.2, "train/box_loss": 3 }];

  it("lists the metric keys present in any history, without epoch", () => {
    expect(curveKeys([h1, h2]).sort()).toEqual([
      "metrics/mAP50(B)",
      "train/box_loss",
      "val/box_loss",
    ]);
  });

  it("defaults to a known headline key when present, else the first key, else null", () => {
    expect(defaultCurveKey(["val/box_loss", "metrics/mAP50(B)"])).toBe("metrics/mAP50(B)");
    expect(defaultCurveKey(["metrics/accuracy_top1", "x"])).toBe("metrics/accuracy_top1");
    expect(defaultCurveKey(["ap_50"])).toBe("ap_50");
    expect(defaultCurveKey([])).toBeNull();
  });

  it("extracts the points of one key, skipping epochs where it is absent", () => {
    expect(curveSeries(h2, "train/box_loss")).toEqual([{ epoch: 1, value: 3 }]);
    expect(curveSeries(h2, "val/box_loss")).toEqual([]);
    expect(curveSeries(h1, "metrics/mAP50(B)")).toEqual([
      { epoch: 1, value: 0.1 },
      { epoch: 2, value: 0.3 },
    ]);
  });
});

describe("confusionDifference", () => {
  const a = { labels: ["polyp", "feces", "background"], matrix: [[4, 1, 0], [0, 2, 1], [1, 0, 0]] };
  const b = { labels: ["polyp", "feces", "background"], matrix: [[5, 0, 0], [0, 3, 0], [0, 0, 0]] };

  it("is B minus A cell by cell", () => {
    const result = confusionDifference(a, b)!;

    expect(result.labels).toEqual(["polyp", "feces", "background"]);
    expect(result.diff).toEqual([[1, -1, 0], [0, 1, -1], [-1, 0, 0]]);
  });

  it("aligns by label name, not by index, and uses only labels both have", () => {
    const shuffled = { labels: ["feces", "polyp"], matrix: [[3, 0], [0, 5]] };
    const result = confusionDifference(a, shuffled)!;

    expect(result.labels).toEqual(["polyp", "feces"]);
    expect(result.diff).toEqual([[1, -1], [0, 1]]);
  });

  it("is null when either matrix is missing or no label overlaps", () => {
    expect(confusionDifference(null, b)).toBeNull();
    expect(confusionDifference(a, null)).toBeNull();
    expect(confusionDifference(a, { labels: ["x"], matrix: [[1]] })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd frontend && npx vitest run src/features/training/compareLogic.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `compareLogic.ts` to satisfy the tests (all functions pure, no React). Key rules:
  - `bestAndDeltas`: count non-null values; `bestIndex = null` when fewer than 2 non-null or all non-null values equal; otherwise the index of the max (or min when `lowerBetter`), first index on ties; `deltas[i] = values[i] - values[0]` only when `i > 0`, `values[0] !== null` and `values[i] !== null`, else `null`.
  - `finalMetricRows`: numeric (`typeof === "number"` and finite) entries only; row order = first-seen key order across runs; `lowerBetter = lowerIsBetter(key)`.
  - `perClassColumns`/`perClassRowsFor`: class names from `row.class` (string); columns are the numeric keys other than `class`, first-seen order; class order first-seen across runs; a run lacking the class gives `null`.
  - `configDifferences`: for each key in the union of `config` keys, string-compare `String(value)` (missing → `"—"`, `null` → `"—"`); skip equal rows; label from `allFields(schema)` when `schema` is given, else the key; order: the base-model row first (key `"__base"`, values `base_model` or `↳ base_model` when `base_model_version_id != null`; included only when the rendered values differ), then keys in schema order, then unknown keys alphabetically.
  - `defaultCurveKey`: first present of `metrics/mAP50(B)`, `mAP50`, `metrics/accuracy_top1`, `accuracy_top1`; else `keys[0] ?? null`.
  - `confusionDifference`: labels in A's order that also exist in B; `diff[i][j] = B[ib(i)][ib(j)] - A[ia(i)][ia(j)]`; `null` for a missing matrix or no common label.

- [ ] **Step 4: Run to verify pass** — same command — Expected: PASS; tsc filter prints nothing.

- [ ] **Step 5: Commit** — `git add frontend/src/features/training && git commit -m "feat: pure data shaping for the run comparison"` (+ trailer).

---

### Task 2: `compare` in the URL and parallel metrics loading

**Files:** Modify `useTrainUrl.ts`, `useTrainUrl.test.tsx`; create `useCompareMetrics.ts`, `useCompareMetrics.test.ts`.

**Interfaces:**
- `TrainUrlState` gains `compare: number[]` (default `[]`). Parsing: `compare=268,406` → positive integers only, unique, in order, at most `MAX_COMPARE` (3), anything else dropped. `update({ compare: ids })` writes `compare=` (omitted when empty). A patch that sets `compare` to 2+ ids does not touch `run`; the page decides what to show. Switching dataset clears `compare` (like `run`).
- `useCompareMetrics(runIds: number[]): { byId: Record<number, RunMetricsRead | null>; loading: boolean; error: boolean }` — requests `GET /training/runs/{run_id}/metrics` for each id in parallel; a request counter keyed on the joined ids list drops answers from an older selection; an id that fails sets `error` and leaves `byId[id] = null` (the others still show); empty list → no requests.

- [ ] **Step 1: Write the failing tests**

`useTrainUrl.test.tsx` additions: reads `compare=268,406`; drops duplicates, zero, negatives, non-numbers and the 4th+ id (`compare=1,2,2,x,0,3,4` → `[1,2,3]`); a patch `{ compare: [1, 2] }` is written as `compare=1%2C2` or `compare=1,2` and round-trips; `{ compare: [] }` removes it; switching dataset clears `compare`; defaults to `[]`.

`useCompareMetrics.test.ts` (mock `apiClient` as in the other hook tests): one request per id with `params: { path: { run_id } }`; `byId` filled; an empty list makes no request; changing the ids drops a late answer from the previous selection (deferred promises); a failed id sets `error` and keeps the others; `loading` true until all settle.

- [ ] **Step 2–4:** run (FAIL), implement, run (PASS) + tsc filter.
- [ ] **Step 5: Commit** — `feat: compare ids in the URL and parallel run-metrics loading`.

---

### Task 3: Selection in the runs table

**Files:** Modify `RunsTable.tsx`, `RunsTable.test.tsx`.

**Interfaces (additions):** props `selectedForCompare: number[]`, `onToggleCompare(runId: number)`, `onCompare()`. A leading checkbox column (`<input type="checkbox" aria-label="Select run <id> for comparison">`); a header line above the table: "Compare" button (`disabled` until at least 2 selected, text `Compare (n)`), and the hint "Select 2–3 runs of this dataset." Only runs with status `succeeded` or `stopped` can be selected (others: checkbox disabled, `title="Only finished runs can be compared"`); when 3 are selected the other checkboxes are disabled with `title="You can compare up to 3 runs"`. Clicking a checkbox must not open the row.

- [ ] **Step 1: Failing tests** (behaviour): checkbox per row with the accessible name; toggling calls `onToggleCompare(id)` and does not call `onOpen`; failed/active runs have disabled checkboxes with the reason; with 3 selected the unselected ones are disabled with the reason, the selected ones stay enabled (so they can be unticked); Compare is disabled with 0–1 selected, enabled with 2–3, shows the count and calls `onCompare`; the hint renders; existing tests still pass (new props default to `[]`/no-ops when omitted so older call sites keep compiling — or update the call sites).
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS) + tsc filter.
- [ ] **Step 5: Commit** — `feat: select runs for comparison in the runs table`.

---

### Task 4: Compare charts and tables

**Files:** Create `CompareCurves.tsx`, `CompareTables.tsx` (+ tests).

**Interfaces:**
- `CompareRunInfo = { id: number; label: string; color: string }` (colors from a fixed 3-color palette exported as `COMPARE_COLORS`, distinct from each other and readable on a dark background).
- `CompareCurves({ runs, histories })` (`histories: HistoryPoint[][]` aligned with `runs`): a metric `<select aria-label="Curve metric">` listing `curveKeys(histories)` (default `defaultCurveKey`), one SVG polyline per run for the chosen key (x = epoch, y = value, shared axes with min/max over all runs, axis tick labels, a legend with the run labels and colors), fixed viewBox with `min-h-[280px]`, a caption "One line per run for the chosen metric." and an empty state "No training history to compare." when no run has any history; a run without that key is listed in the legend as "(no data)".
- `CompareTables({ runs, runObjects, metrics, schema })` renders three sections, each with a `<h3>` and a one-line caption:
  1. **Configuration differences** (`configDifferences`): a table `Setting | #a | #b | #c`; empty state "No setting differs between these runs."
  2. **Final metrics** (`finalMetricRows`): columns per run; the best value `font-semibold text-green-300` with `title="Best among the compared runs"`, deltas shown beneath the value as `+0.123`/`−0.045` (muted, sign explicit, 3 decimals) for runs after the first; "—" for missing; empty state "No final metrics reported."
  3. **Per-class metrics** (`perClassRowsFor`): a `<select aria-label="Per-class metric">` of `perClassColumns`; table `Class | #a | #b | #c` with the same best/delta rules; empty state "No per-class metrics for these runs."

- [ ] **Step 1: Failing tests**: the chart's key selector default and change (the number of polylines stays equal to the runs with data; a run with no data is marked), legend labels, empty state; the tables render only differing settings, mark only the best, show deltas with explicit signs and only for non-first runs, show "—" for missing, switch the per-class column, show each section's empty state, and every section has its caption.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS) + tsc filter.
- [ ] **Step 5: Commit** — `feat: compare curves and tables`.

---

### Task 5: Confusion matrices side by side and their difference

**Files:** Create `ConfusionCompare.tsx` (+ test).

**Interfaces:** `ConfusionCompare({ runs, confusions })` (`confusions: Array<Confusion | null>` aligned with `runs`): a grid with one `ConfusionMatrix` (existing component) per run under its label (a run without a matrix shows "No confusion matrix for this run."); for EXACTLY two runs a toggle button `aria-pressed` "Show difference (B − A)" that replaces the grid with a signed table from `confusionDifference` (rows = true label, columns = predicted, cells `+n` green / `−n` red / `0` muted, row and column headers the labels; the caption states which run is A and which is B); when `confusionDifference` is `null` the toggle is disabled with `title="No common labels or a matrix is missing"`. With 3 runs no toggle. Caption "Rows are the true class, columns the predicted one." Section caption for the whole block.

- [ ] **Step 1: Failing tests**: one matrix per run with its label; missing-matrix message; the toggle exists only for two runs, switches to the difference table with signed cells and the A/B legend, and back; it is disabled with the reason when there is no overlap; no toggle for three runs.
- [ ] **Step 2–4:** run (FAIL), implement (reuse `ConfusionMatrix` as is), run (PASS) + tsc filter.
- [ ] **Step 5: Commit** — `feat: confusion matrices side by side with a difference view`.

---

### Task 6: Compare view and page wiring

**Files:** Create `CompareView.tsx` (+ test); modify `TrainPage.tsx` and `TrainPage.test.tsx`.

**Interfaces:** `CompareView({ runs, schema, onBack, onRemove(runId) })`: header (`← Runs`, "Comparing #a, #b, #c", a chip per run with an "×" button `aria-label="Remove run <id> from the comparison"` that calls `onRemove`), loading and error states from `useCompareMetrics(runs.map(r => r.id))` (an error for one run shows a note naming it and still renders the rest), then `CompareCurves`, `CompareTables`, `ConfusionCompare`, in that order, each fed from `byId`. `TrainPage`:
- `const ids = url.compare.filter(id => runs.some(r => r.id === id))`; ids not in this dataset's runs (or not finished) are dropped; a muted note "Some runs in the link are not on this dataset and were left out." when anything was dropped; `ids.length >= 2` → render `CompareView` instead of the table/details (in the Runs panel), else the table (and the note).
- Table selection state = `url.compare` filtered to this dataset's finished runs (the checkboxes reflect the URL); `onToggleCompare` toggles through ONE `update({ compare })` patch (cap 3). Ticking boxes never switches screens: the view opens only when the URL also carries an explicit marker, so add `compareOpen: boolean` to `useTrainUrl` state (`cmp=1`; parsed as true only for exactly `1`; omitted when false); the table's Compare button (`onCompare`, enabled with 2–3 ticks) sets `compareOpen: true`, and the view's `← Runs` (`onBack`) sets it back to false, keeping the ticks.
- `onRemove(runId)` removes it from `compare`; falling below 2 returns to the table keeping the remaining tick.
- Opening a single run (`run=`) and the compare view are mutually exclusive: opening a run clears `cmp`.
- Dataset switch clears `compare`/`cmp`/`run`.
- Every interaction is ONE `update` patch (the hook's `update` closes over state).

- [ ] **Step 1: Failing tests**: `CompareView.test.tsx` with mocked `apiClient` — renders the three sections for two runs, the chips remove a run, one failing run shows a note and the rest still render, loading text; `TrainPage.test.tsx` — ticking two finished runs and pressing Compare opens the compare view and writes `compare=…&cmp=1` in the URL; `← Runs` returns to the table keeping the ticks; a link with `compare=268,99999&cmp=1` drops the foreign id, shows the note and falls back to the table (fewer than 2 valid ids); a deep link `compare=268,199&cmp=1` renders the view after reload; removing a run from the view below two returns to the table; opening a single run clears the compare view; switching the dataset clears everything; a late metrics answer for an older selection never shows (deferred promises).
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS), then the whole training folder and the tsc filter.
- [ ] **Step 5: Commit** — `feat: run comparison view wired into the Train page`.

---

### Task 7: Live verification and ROADMAP

Controller-executed; approvals for a short GPU run and for touching the running stack are needed at that time (earlier ones do not carry over).

- [ ] **Step 1:** Make sure the stack is up (Postgres/Redis/MinIO containers, `ml-worker` from the current image, backend on :8000, Vite on :5173). If another project holds 5432/6379 after a boot, ask before stopping it.
- [ ] **Step 2:** In the browser (`manualcheck@example.com` / `manual-check-pass`, dataset 009/496) the runs 268 (50 epochs, with history, per-class and matrix) and 199 (older: no history/per-class/matrix) already exist: tick both and Compare — verify the empty states for 199 (no curve, "—" cells, "No confusion matrix for this run"), the config differences (epochs 50 vs 100), the best/delta rules.
- [ ] **Step 3:** Start one short run (Quick check preset, size n, 3 epochs) to get a third comparable run with full data; compare 268 + the new run: curves overlaid with the metric selector, final-metrics deltas, per-class column switch, the confusion difference toggle (two runs), then three runs (no toggle), the 4th checkbox disabled, reload on the compare URL, Back/Forward, removing a chip, an invalid id in the link. Check wide (1920) and narrow (900 px: wide tables scroll inside their container, page does not).
- [ ] **Step 4:** Delete the run created in Step 3 (model first, then run) and confirm the DB and MinIO are as before (`select count(*)` on training_runs/model_versions/jobs vs the recorded counts; `models/` only `268`).
- [ ] **Step 5:** ROADMAP entry "Phase 2b: Train workspace, plan 3 (compare) — DONE", with the commit range, what was verified live, deviations and open items; update the project memory. Commit `docs: record Train workspace plan 3`.

---

## Self-Review

- **Spec coverage:** config differences, overlaid curves with a metric selector (default headline), final-metrics table with best and deltas against the first, per-class run × class table with deltas, confusion matrices side by side and B − A for exactly two runs, captions per section, union-of-keys tables, same-dataset restriction, URL state (Tasks 1–6); live check (Task 7).
- **Placeholder scan:** component tests in Tasks 2–6 are specified by behaviour, with exact data-shaping tests in Task 1 (the logic that can silently mislead); the implementer writes component test bodies in the style of the existing tests.
- **Type consistency:** `MetricRow`, `ConfigRow`, `CurvePoint`, `Confusion`, `HistoryPoint`, `COMPARE_COLORS`, `MAX_COMPARE`, `compare`/`compareOpen` in `TrainUrlState` are used identically across tasks.
- **Known simplification:** `compareOpen` (`cmp=1`) is the one addition to the spec's URL sketch, needed so ticking boxes does not switch screens.
