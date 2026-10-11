import { allFields, type SettingsSchema } from "./settingsLogic";

export const MAX_COMPARE = 3;

export type Num = number | null;
export interface MetricRow {
  key: string;
  values: Num[];
  bestIndex: number | null;
  deltas: Num[];
}
export interface ConfigRow {
  key: string;
  label: string;
  values: string[];
}
export interface CurvePoint {
  epoch: number;
  value: number;
}
export interface RunLike {
  id: number;
  base_model: string;
  base_model_version_id?: number | null;
  config: Record<string, unknown>;
}
export type PerClassRow = Record<string, unknown>;
export type HistoryPoint = Record<string, number>;
export interface Confusion {
  labels: string[];
  matrix: number[][];
}

const MISSING = "—";
const HEADLINE_KEYS = ["metrics/mAP50(B)", "mAP50", "metrics/accuracy_top1", "accuracy_top1"];

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function runLabel(run: { id: number; name: string | null }): string {
  return run.name ? `#${run.id} ${run.name}` : `#${run.id}`;
}

export function lowerIsBetter(key: string): boolean {
  return key.toLowerCase().includes("loss");
}

export function bestAndDeltas(
  values: Num[],
  lowerBetter: boolean,
): { bestIndex: number | null; deltas: Num[] } {
  values = values.map((v) => (v !== null && Number.isFinite(v) ? v : null));
  const present = values.filter((v): v is number => v !== null);
  let bestIndex: number | null = null;
  if (present.length >= 2 && present.some((v) => v !== present[0])) {
    const target = lowerBetter ? Math.min(...present) : Math.max(...present);
    bestIndex = values.findIndex((v) => v === target);
  }
  const first = values[0];
  const deltas = values.map((v, i) => (i > 0 && first !== null && v !== null ? v - first : null));
  return { bestIndex, deltas };
}

export function configDifferences(runs: RunLike[], schema: SettingsSchema | null): ConfigRow[] {
  const render = (run: RunLike, key: string): string => {
    const value = run.config[key];
    if (value === undefined || value === null) return MISSING;
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  };
  const labels = new Map<string, string>();
  const order = new Map<string, number>();
  if (schema) {
    allFields(schema).forEach((field, index) => {
      labels.set(field.key, field.label);
      order.set(field.key, index);
    });
  }
  const keys = new Set<string>();
  for (const run of runs) {
    for (const key of Object.keys(run.config)) keys.add(key);
  }
  const sorted = [...keys].sort((a, b) => {
    const ia = order.get(a);
    const ib = order.get(b);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const rows: ConfigRow[] = [];
  const baseValues = runs.map((run) =>
    run.base_model_version_id != null ? `↳ ${run.base_model}` : run.base_model,
  );
  if (new Set(baseValues).size > 1) {
    rows.push({ key: "__base", label: "Base model", values: baseValues });
  }
  for (const key of sorted) {
    const values = runs.map((run) => render(run, key));
    if (new Set(values).size > 1) {
      rows.push({ key, label: labels.get(key) ?? key, values });
    }
  }
  return rows;
}

export function finalMetricRows(metricsList: Array<Record<string, unknown> | null>): MetricRow[] {
  const keys: string[] = [];
  for (const metrics of metricsList) {
    for (const [key, value] of Object.entries(metrics ?? {})) {
      if (isNum(value) && !keys.includes(key)) keys.push(key);
    }
  }
  return keys.map((key) => {
    const values = metricsList.map((metrics) => {
      const value = metrics?.[key];
      return isNum(value) ? value : null;
    });
    return { key, values, ...bestAndDeltas(values, lowerIsBetter(key)) };
  });
}

export function perClassColumns(sets: PerClassRow[][]): string[] {
  const columns: string[] = [];
  for (const rows of sets) {
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        if (key !== "class" && isNum(value) && !columns.includes(key)) columns.push(key);
      }
    }
  }
  return columns;
}

export function perClassRowsFor(
  sets: PerClassRow[][],
  column: string,
): Array<{ cls: string } & MetricRow> {
  const classes: string[] = [];
  for (const rows of sets) {
    for (const row of rows) {
      if (typeof row.class === "string" && !classes.includes(row.class)) classes.push(row.class);
    }
  }
  return classes.map((cls) => {
    const values = sets.map((rows) => {
      const value = rows.find((row) => row.class === cls)?.[column];
      return isNum(value) ? value : null;
    });
    return { cls, key: cls, values, ...bestAndDeltas(values, lowerIsBetter(column)) };
  });
}

export function curveKeys(histories: HistoryPoint[][]): string[] {
  const keys: string[] = [];
  for (const history of histories) {
    for (const point of history) {
      for (const [key, value] of Object.entries(point)) {
        if (key !== "epoch" && isNum(value) && !keys.includes(key)) keys.push(key);
      }
    }
  }
  return keys;
}

export function defaultCurveKey(keys: string[]): string | null {
  return HEADLINE_KEYS.find((key) => keys.includes(key)) ?? keys[0] ?? null;
}

export function curveSeries(history: HistoryPoint[], key: string): CurvePoint[] {
  const points: CurvePoint[] = [];
  for (const point of history) {
    const value = point[key];
    if (isNum(value) && isNum(point.epoch)) points.push({ epoch: point.epoch, value });
  }
  return points.sort((a, b) => a.epoch - b.epoch);
}

export function confusionDifference(
  a: Confusion | null,
  b: Confusion | null,
): { labels: string[]; diff: number[][] } | null {
  if (!a || !b) return null;
  const labels = a.labels.filter((label) => b.labels.includes(label));
  if (labels.length === 0) return null;
  const ia = labels.map((label) => a.labels.indexOf(label));
  const ib = labels.map((label) => b.labels.indexOf(label));
  const diff = labels.map((_, i) =>
    labels.map((_, j) => (b.matrix[ib[i]]?.[ib[j]] ?? 0) - (a.matrix[ia[i]]?.[ia[j]] ?? 0)),
  );
  return { labels, diff };
}
