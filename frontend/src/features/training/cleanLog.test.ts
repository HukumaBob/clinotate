import { describe, expect, it } from "vitest";

import { cleanLog, foldArchitecture } from "./cleanLog";

const ESC = "\x1b";
const trainBar = (percent: number, step: number) =>
  `\r${ESC}[K        2/3      0.613G      1.116      3.393      1.478          7        640: ${percent}% ━╸───── ${step}/16 6.6it/s 0.4s<2.0s`;
const valBar = (percent: number, step: number) =>
  `\r${ESC}[K                 Class     Images  Instances      Box(P          R      mAP50  mAP50-95): ${percent}% ━━━──── ${step}/3 21.6it/s 0.1s`;

describe("cleanLog", () => {
  it("removes ANSI codes and carriage returns", () => {
    const raw = `\r${ESC}[K${ESC}[34m${ESC}[1mtrain: ${ESC}[0mScanning labels`;

    expect(cleanLog(raw)).toBe("train: Scanning labels");
  });

  it("keeps only the last update of one progress bar", () => {
    const raw = [trainBar(6, 1), trainBar(18, 3), trainBar(100, 16)].join("\n");

    expect(cleanLog(raw).split("\n")).toEqual([
      expect.stringContaining("100%"),
    ]);
  });

  it("keeps the training bar and the validation bar that follows it apart", () => {
    const raw = [trainBar(50, 8), trainBar(100, 16), valBar(33, 1), valBar(100, 3)].join("\n");

    const lines = cleanLog(raw).split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("2/3");
    expect(lines[0]).toContain("16/16");
    expect(lines[1]).toContain("Class");
    expect(lines[1]).toContain("3/3");
  });

  it("starts a new group after an ordinary line, so the next epoch keeps its own bar", () => {
    const raw = [trainBar(100, 16), "all   24   26   0.9", trainBar(10, 2)].join("\n");

    expect(cleanLog(raw).split("\n")).toHaveLength(3);
  });

  it("never treats a plain line that merely mentions a percentage as a progress bar", () => {
    const raw = ["Accuracy improved 12% over baseline", "Accuracy improved 14% over baseline"].join("\n");

    expect(cleanLog(raw).split("\n")).toEqual([
      "Accuracy improved 12% over baseline",
      "Accuracy improved 14% over baseline",
    ]);
  });

  it("keeps the first and the last line even when the log ends mid-bar", () => {
    const raw = ["Epoch    GPU_mem", trainBar(18, 3)].join("\n");

    expect(cleanLog(raw).split("\n")).toEqual([
      "Epoch    GPU_mem",
      expect.stringContaining("18%"),
    ]);
  });

  it("collapses runs of blank lines to one and drops trailing whitespace", () => {
    expect(cleanLog("a   \n\n\n\nb")).toBe("a\n\nb");
  });

  it("returns an empty string for an empty log", () => {
    expect(cleanLog("")).toBe("");
  });
});

describe("foldArchitecture", () => {
  const excerpt = [
    "Overriding model.yaml nc=80 with nc=1",
    "",
    "                   from  n    params  module                                       arguments",
    "  0                  -1  1       464  ultralytics.nn.modules.conv.Conv             [3, 16, 3, 2]",
    "  1                  -1  1      4672  ultralytics.nn.modules.conv.Conv             [16, 32, 3, 2]",
    " 23        [16, 19, 22]  1    430867  ultralytics.nn.modules.head.Detect           [1, [64, 128, 256]]",
    "YOLO11n summary: 181 layers, 2,590,035 parameters, 2,590,019 gradients, 6.4 GFLOPs",
    "",
    "Transferred 448/499 items from pretrained weights",
  ].join("\n");

  it("splits the table from the header through the summary line", () => {
    const folded = foldArchitecture(excerpt);

    expect(folded.before).toBe("Overriding model.yaml nc=80 with nc=1\n");
    expect(folded.architecture).toHaveLength(5);
    expect(folded.architecture![0]).toMatch(/from\s+n\s+params/);
    expect(folded.architecture![4]).toMatch(/^YOLO11n summary:/);
    expect(folded.after).toBe("\nTransferred 448/499 items from pretrained weights");
  });

  it("folds a table that has no summary line yet", () => {
    const folded = foldArchitecture(excerpt.split("\n").slice(0, 5).join("\n"));

    expect(folded.architecture).toHaveLength(3);
    expect(folded.after).toBe("");
  });

  it("reports no architecture when the header is absent", () => {
    expect(foldArchitecture("a\nb")).toEqual({ before: "a\nb", architecture: null, after: "" });
  });
});
