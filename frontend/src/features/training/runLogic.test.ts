import { describe, expect, it } from "vitest";

import {
  baseKeyFromRun,
  bestRunId,
  formatDuration,
  headlineScore,
  headlineValue,
  settingsLine,
  valuesFromConfig,
} from "./runLogic";
import { settingsSchemaFixture as schema } from "./testFixtures";

const run = (over: Record<string, unknown>) =>
  ({
    id: 1,
    status: "succeeded",
    task_type: "detection",
    metrics: {},
    base_model: "yolo11n.pt",
    base_model_version_id: null,
    config: {},
    ...over,
  }) as never;

describe("headline metric", () => {
  it("picks the known key per task", () => {
    expect(headlineScore("detection", { "metrics/mAP50(B)": 0.712 })).toEqual({
      label: "mAP50",
      value: "0.712",
    });
    expect(headlineScore("classification", { "metrics/accuracy_top1": 0.957 })).toEqual({
      label: "top-1",
      value: "0.957",
    });
  });

  it("falls back to the first numeric entry with its own key, and to a dash", () => {
    expect(headlineScore("detection", { ap_50: 0.4 })).toEqual({ label: "ap_50", value: "0.400" });
    expect(headlineScore("detection", {})).toEqual({ label: "", value: "—" });
  });

  it("exposes the raw number only for a known key", () => {
    expect(headlineValue("detection", { "metrics/mAP50(B)": 0.5 })).toBe(0.5);
    expect(headlineValue("classification", { "metrics/accuracy_top1": 0.9 })).toBe(0.9);
    expect(headlineValue("detection", { ap_50: 0.4 })).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats finished runs", () => {
    expect(formatDuration("2026-10-09T10:00:00Z", "2026-10-09T10:01:05Z")).toBe("1m 05s");
    expect(formatDuration("2026-10-09T10:00:00Z", "2026-10-09T11:02:03Z")).toBe("1h 02m");
    expect(formatDuration("2026-10-09T10:00:00Z", "2026-10-09T10:00:07Z")).toBe("7s");
  });

  it("counts a running run up to now, and shows a dash before it started", () => {
    expect(
      formatDuration("2026-10-09T10:00:00Z", null, new Date("2026-10-09T10:00:30Z")),
    ).toBe("30s");
    expect(formatDuration(null, null)).toBe("—");
  });
});

describe("formatDuration with bad input", () => {
  it("returns a dash for an unparsable date", () => {
    expect(formatDuration("garbage", null)).toBe("—");
    expect(formatDuration("2026-10-09T10:00:00Z", "garbage")).toBe("—");
  });
});

describe("settingsLine", () => {
  it("summarises the settings that matter in one line", () => {
    expect(
      settingsLine({ imgsz: 640, batch: 4, epochs: 50, freeze: 10, optimizer: "AdamW" }),
    ).toBe("640 · b4 · 50 ep · freeze 10 · AdamW");
  });

  it("leaves out what is absent or automatic", () => {
    expect(settingsLine({ imgsz: 640, batch: 8, epochs: 3, optimizer: "auto" })).toBe(
      "640 · b8 · 3 ep",
    );
    expect(settingsLine({})).toBe("");
  });

  it("skips null imgsz, batch and epochs", () => {
    expect(settingsLine({ imgsz: null, batch: undefined, epochs: 5 })).toBe("5 ep");
  });
});

describe("bestRunId", () => {
  it("is the finished run with the highest known headline value", () => {
    const runs = [
      run({ id: 1, metrics: { "metrics/mAP50(B)": 0.3 } }),
      run({ id: 2, metrics: { "metrics/mAP50(B)": 0.7 } }),
      run({ id: 3, status: "failed", metrics: { "metrics/mAP50(B)": 0.99 } }),
    ];

    expect(bestRunId(runs)).toBe(2);
  });

  it("is null when no run has a comparable number or only one run exists", () => {
    expect(bestRunId([run({ id: 1, metrics: { ap_50: 0.4 } }), run({ id: 2 })])).toBeNull();
    expect(bestRunId([run({ id: 1, metrics: { "metrics/mAP50(B)": 0.3 } })])).toBeNull();
  });
});

describe("prefill from a run", () => {
  it("uses the version when the run was a fine-tune, the weights name otherwise", () => {
    expect(baseKeyFromRun(run({ base_model_version_id: 7, base_model: "parent" }))).toBe("version:7");
    expect(baseKeyFromRun(run({}))).toBe("pretrained:yolo11n.pt");
  });

  it("copies known settings over the defaults and ignores unknown keys", () => {
    const values = valuesFromConfig(schema, { epochs: 12, optimizer: "AdamW", removed_key: 1 });

    expect(values.epochs).toBe(12);
    expect(values.optimizer).toBe("AdamW");
    expect(values.batch).toBe(8); // not in the config -> default
    expect("removed_key" in values).toBe(false);
    expect(values.freeze).toBeNull();
  });
});
