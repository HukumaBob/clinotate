import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { components } from "../../shared/api/generated/schema";
import { ActiveRunStrip } from "./ActiveRunStrip";

type Run = components["schemas"]["TrainingRunRead"];

const base = {
  id: 7, status: "running", name: "big frames", base_model: "yolo11n.pt",
  current_epoch: 3, total_epochs: 10, stop_requested: false,
} as unknown as Run;

function setup(over: Partial<Run> = {}, props: Partial<React.ComponentProps<typeof ActiveRunStrip>> = {}) {
  const handlers = { onStop: vi.fn(), onOpen: vi.fn() };
  render(
    <ActiveRunStrip
      run={{ ...base, ...over } as Run}
      headline={{ label: "mAP50", value: "0.412" }}
      stopPending={false}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("ActiveRunStrip", () => {
  it("shows id, name, epoch and the headline score", () => {
    setup();
    expect(screen.getByText(/#7/)).toBeInTheDocument();
    expect(screen.getByText(/big frames/)).toBeInTheDocument();
    expect(screen.getByText(/epoch 3 \/ 10/i)).toBeInTheDocument();
    expect(screen.getByText(/mAP50 0\.412/)).toBeInTheDocument();
  });

  it("falls back to the base model when the run has no name", () => {
    setup({ name: null });
    expect(screen.getByText(/yolo11n\.pt/)).toBeInTheDocument();
  });

  it("renders a progress bar at the epoch percentage", () => {
    setup();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "30");
  });

  it("Stop calls onStop and the epoch-boundary sentence is shown", () => {
    const { onStop } = setup();
    expect(screen.getByText("Stops after the current epoch finishes.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalled();
  });

  it("shows Stopping… disabled when a stop was requested or is pending", () => {
    setup({ stop_requested: true });
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  });

  it("shows Stopping… while the stop request is in flight", () => {
    setup({}, { stopPending: true });
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  });

  it("opens the run when the text area is clicked", () => {
    const { onOpen } = setup();
    fireEvent.click(screen.getByText(/big frames/));
    expect(onOpen).toHaveBeenCalled();
  });

  it("renders a pending run and shows 0% without NaN when total_epochs is 0", () => {
    setup({ status: "pending", current_epoch: 0, total_epochs: 0 });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
  });

  it("renders nothing for a finished run", () => {
    const { container } = render(
      <ActiveRunStrip run={{ ...base, status: "succeeded" } as Run} headline={{ label: "", value: "—" }}
        stopPending={false} onStop={vi.fn()} onOpen={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
