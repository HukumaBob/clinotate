import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LogView, shouldStickToBottom } from "./LogView";

describe("LogView", () => {
  it("renders the cleaned log, not the raw one", () => {
    render(<LogView text={"\r\x1b[K\x1b[34mhello\x1b[0m"} />);

    expect(screen.getByRole("log")).toHaveTextContent("hello");
    expect(screen.getByRole("log").textContent).not.toContain("\x1b");
  });

  it("says when there is nothing yet", () => {
    render(<LogView text="" />);

    expect(screen.getByText(/no log output yet/i)).toBeInTheDocument();
  });
});

describe("shouldStickToBottom", () => {
  it("follows the tail when the reader is within the tolerance of the bottom", () => {
    expect(shouldStickToBottom(900, 100, 1000)).toBe(true);
    expect(shouldStickToBottom(880, 100, 1000)).toBe(true);
  });

  it("lets go when the reader scrolled up", () => {
    expect(shouldStickToBottom(500, 100, 1000)).toBe(false);
  });

  it("returns true when scrolled exactly to the bottom", () => {
    expect(shouldStickToBottom(400, 100, 500)).toBe(true);
  });

  it("returns false when scrolled up well beyond the tolerance", () => {
    expect(shouldStickToBottom(200, 100, 500)).toBe(false);
  });

  it("returns true when within the tolerance of the bottom", () => {
    expect(shouldStickToBottom(390, 100, 500)).toBe(true);
  });

  it("returns true for the jsdom zero-height case", () => {
    expect(shouldStickToBottom(0, 0, 0)).toBe(true);
  });

  it("honors an explicit tolerance override", () => {
    expect(shouldStickToBottom(350, 100, 500, 5)).toBe(false);
    expect(shouldStickToBottom(350, 100, 500, 60)).toBe(true);
  });
});

describe("LogView architecture fold", () => {
  const raw = [
    "Overriding model.yaml",
    "                   from  n    params  module                                       arguments",
    "  0                  -1  1       464  ultralytics.nn.modules.conv.Conv             [3, 16, 3, 2]",
    "YOLO11n summary: 181 layers, 6.4 GFLOPs",
    "Transferred 448/499 items",
  ].join("\n");

  it("folds the architecture block into a collapsed details with a line count", () => {
    const { container } = render(<LogView text={raw} />);

    const details = container.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("Model architecture (3 lines)")).toBeInTheDocument();
    expect(screen.getByRole("log")).toHaveTextContent("Transferred 448/499 items");
  });

  it("caps the pane height", () => {
    render(<LogView text="x" />);

    expect(screen.getByRole("log").className).toContain("max-h-[60vh]");
  });
});
