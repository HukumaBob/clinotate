import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { TrackControls } from "../src/features/annotation/TrackControls";

describe("TrackControls", () => {
  it("disables the Track button when there are no pending prompts", () => {
    const store = createFrameEditorStore();
    store.getState().setLabelSelection({ labelTagId: 1 });

    render(<TrackControls store={store} onTrack={vi.fn()} maxBackward={10} maxForward={20} />);

    expect(screen.getByRole("button", { name: "Track" })).toBeDisabled();
  });

  it("enables the Track button once a point prompt is pending", () => {
    const store = createFrameEditorStore();
    store.getState().setLabelSelection({ labelTagId: 1 });
    store.getState().addPrompt({ type: "point", coords: [0.5, 0.5], label: true });

    render(<TrackControls store={store} onTrack={vi.fn()} maxBackward={10} maxForward={20} />);

    expect(screen.getByRole("button", { name: "Track" })).toBeEnabled();
  });

  it("enables the Track button once a mask prompt is pending", () => {
    const store = createFrameEditorStore();
    store.getState().setLabelSelection({ labelTagId: 1 });
    store.getState().setMaskPrompt("base64data");

    render(<TrackControls store={store} onTrack={vi.fn()} maxBackward={10} maxForward={20} />);

    expect(screen.getByRole("button", { name: "Track" })).toBeEnabled();
  });

  it("disables the Track button when no tag is selected even with pending prompts", () => {
    const store = createFrameEditorStore();
    store.getState().addPrompt({ type: "point", coords: [0.5, 0.5], label: true });

    render(<TrackControls store={store} onTrack={vi.fn()} maxBackward={10} maxForward={20} />);

    expect(screen.getByRole("button", { name: "Track" })).toBeDisabled();
  });

  it("clicking Max next to Backward sets backward to maxBackward", async () => {
    const store = createFrameEditorStore();
    render(<TrackControls store={store} onTrack={vi.fn()} maxBackward={7} maxForward={20} />);

    await userEvent.click(screen.getByRole("button", { name: "Max backward" }));

    expect(store.getState().backward).toBe(7);
  });

  it("clicking Max next to Forward sets forward to maxForward", async () => {
    const store = createFrameEditorStore();
    render(<TrackControls store={store} onTrack={vi.fn()} maxBackward={10} maxForward={13} />);

    await userEvent.click(screen.getByRole("button", { name: "Max forward" }));

    expect(store.getState().forward).toBe(13);
  });
});
