import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { TrackControls } from "../src/features/annotation/TrackControls";

describe("TrackControls", () => {
  it("shows nonzero default values for both fields, never blank", () => {
    const store = createFrameEditorStore();
    render(<TrackControls store={store} onTrack={vi.fn()} />);

    expect(screen.getByLabelText("Backward")).toHaveValue(store.getState().backward);
    expect(screen.getByLabelText("Forward")).toHaveValue(store.getState().forward);
  });

  it("updates the store when a field changes", async () => {
    const store = createFrameEditorStore();
    render(<TrackControls store={store} onTrack={vi.fn()} />);

    await userEvent.clear(screen.getByLabelText("Backward"));
    await userEvent.type(screen.getByLabelText("Backward"), "3");

    expect(store.getState().backward).toBe(3);
  });

  it("calls onTrack when the Track button is clicked", async () => {
    const store = createFrameEditorStore();
    const onTrack = vi.fn();
    render(<TrackControls store={store} onTrack={onTrack} />);

    await userEvent.click(screen.getByRole("button", { name: "Track" }));

    expect(onTrack).toHaveBeenCalled();
  });
});
