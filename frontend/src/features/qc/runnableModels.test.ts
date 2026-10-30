import { describe, expect, it } from "vitest";

import { runnableModels } from "./runnableModels";

describe("runnableModels", () => {
  it("offers YOLO detection and segmentation versions only", () => {
    const models = [
      { id: 1, task_type: "detection", adapter: "ultralytics_yolo" },
      { id: 2, task_type: "segmentation", adapter: "ultralytics_yolo" },
      { id: 3, task_type: "detection", adapter: "dinov3_classifier" },
      { id: 4, task_type: "classification", adapter: "ultralytics_yolo" },
    ];
    expect(runnableModels(models).map((m) => m.id)).toEqual([1, 2]);
  });
});
