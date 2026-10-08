import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ReelsPanel } from "./ReelsPanel";
import { DEFAULT_GREY_BAND, type Reel } from "./reels";

const reels: Reel[] = [
  { startMs: 9_000, endMs: 11_200, reasons: ["blink: polyp"], frameIndices: [100, 102] },
  { startMs: 30_000, endMs: 32_000, reasons: ["low confidence"], frameIndices: [300] },
];

function setup(over: Record<string, unknown> = {}) {
  const props = {
    reels,
    flags: [] as { frame_index: number }[],
    activeIndex: null as number | null,
    band: DEFAULT_GREY_BAND,
    onBandChange: vi.fn(),
    onSelect: vi.fn(),
    isCoarse: false,
    ...over,
  };
  render(<ReelsPanel {...props} />);
  return props;
}

describe("ReelsPanel", () => {
  it("lists each clip with its time range, reasons and frame count", () => {
    setup();
    expect(screen.getByText("blink: polyp")).toBeInTheDocument();
    expect(screen.getByText("low confidence")).toBeInTheDocument();
    expect(screen.getByText("2 frames")).toBeInTheDocument();
    expect(screen.getByText("1 frame")).toBeInTheDocument();
  });

  it("selects a clip on click and deselects the active one", async () => {
    const user = userEvent.setup();
    const props = setup({ activeIndex: 1 });
    await user.click(screen.getByRole("button", { name: /blink: polyp/ }));
    expect(props.onSelect).toHaveBeenCalledWith(0);
    await user.click(screen.getByRole("button", { name: /low confidence/ }));
    expect(props.onSelect).toHaveBeenLastCalledWith(null);
  });

  it("marks a clip reviewed only when a flag lies inside it", () => {
    setup({ flags: [{ frame_index: 300 }] });
    expect(screen.getAllByText("Reviewed")).toHaveLength(1);
  });

  it("steps between clips and disables the buttons at the ends", async () => {
    const user = userEvent.setup();
    const props = setup({ activeIndex: 0 });
    expect(screen.getByRole("button", { name: "Previous reel" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next reel" }));
    expect(props.onSelect).toHaveBeenCalledWith(1);
  });

  it("starts from the first clip when none is active", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "Next reel" }));
    expect(props.onSelect).toHaveBeenCalledWith(0);
  });

  it("explains an empty list", () => {
    setup({ reels: [] });
    expect(screen.getByText("No doubtful moments at these settings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next reel" })).toBeDisabled();
  });

  it("keeps the band ordered and ignores empty input", () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText("Grey zone from"), { target: { value: "0.7" } });
    expect(props.onBandChange).toHaveBeenLastCalledWith({ low: 0.7, high: 0.7 });
    fireEvent.change(screen.getByLabelText("Grey zone to"), { target: { value: "0.1" } });
    expect(props.onBandChange).toHaveBeenLastCalledWith({ low: 0.1, high: 0.1 });
    props.onBandChange.mockClear();
    fireEvent.change(screen.getByLabelText("Grey zone from"), { target: { value: "" } });
    expect(props.onBandChange).not.toHaveBeenCalled();
  });

  it("warns that flicker clips are coarse when the window is", () => {
    setup({ isCoarse: true });
    expect(screen.getByText(/flicker clips/i)).toBeInTheDocument();
  });
});
