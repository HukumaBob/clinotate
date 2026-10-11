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

describe("review leftovers", () => {
  it("configDifferences stringifies objects and arrays instead of [object Object]", () => {
    const rows = configDifferences(
      [
        { id: 1, base_model: "m", config: { aug: { flip: 1 }, sizes: [1, 2] } },
        { id: 2, base_model: "m", config: { aug: { flip: 0 }, sizes: [1, 2] } },
      ],
      null,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toEqual(['{"flip":1}', '{"flip":0}']);
  });

  it("curveSeries is sorted by epoch", () => {
    const points = curveSeries([{ epoch: 3, v: 3 }, { epoch: 1, v: 1 }, { epoch: 2, v: 2 }], "v");
    expect(points.map((p) => p.epoch)).toEqual([1, 2, 3]);
  });

  it("lowerIsBetter ignores case", () => {
    expect(lowerIsBetter("train/Box_Loss")).toBe(true);
  });

  it("bestAndDeltas ignores non-finite values and never returns -1", () => {
    const r = bestAndDeltas([NaN, 0.5, 0.7], false);
    expect(r.bestIndex).toBe(2);
    expect(r.deltas[0]).toBeNull();
    expect(bestAndDeltas([Infinity, 1, 2], false).bestIndex).toBe(2);
    expect(bestAndDeltas([NaN, 1], false).bestIndex).toBeNull();
    expect(bestAndDeltas([1, 2, Infinity], false).deltas[2]).toBeNull();
  });
});
