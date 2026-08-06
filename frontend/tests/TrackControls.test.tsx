import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { TrackControls } from "../src/features/annotation/TrackControls";

describe("TrackControls", () => {
  it("disables the Track button when there are no pending prompts", () => {
    const store = createFrameEditorStore();
    store.getState().setLabelSelection({ labelTagId: 1 });

    render(<TrackControls store={store} onTrack={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Track" })).toBeDisabled();
  });

  it("enables the Track button once a point prompt is pending", () => {
    const store = createFrameEditorStore();
    store.getState().setLabelSelection({ labelTagId: 1 });
    store.getState().addPrompt({ type: "point", coords: [0.5, 0.5], label: true });

    render(<TrackControls store={store} onTrack={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Track" })).toBeEnabled();
  });

  it("enables the Track button once a mask prompt is pending", () => {
    const store = createFrameEditorStore();
    store.getState().setLabelSelection({ labelTagId: 1 });
    store.getState().setMaskPrompt("base64data");

    render(<TrackControls store={store} onTrack={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Track" })).toBeEnabled();
  });

  it("disables the Track button when no tag is selected even with pending prompts", () => {
    const store = createFrameEditorStore();
    store.getState().addPrompt({ type: "point", coords: [0.5, 0.5], label: true });

    render(<TrackControls store={store} onTrack={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Track" })).toBeDisabled();
  });
});
