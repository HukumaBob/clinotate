import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_VIEW_PARAMS } from "./analysis/view";
import { DisplayPanel } from "./DisplayPanel";

function setup(overrides = {}) {
  const props = {
    params: { ...DEFAULT_VIEW_PARAMS },
    onChange: vi.fn(),
    onReset: vi.fn(),
    blinkCount: 0,
    dropoutCount: 0,
    isCoarse: false,
    ...overrides,
  };
  render(<DisplayPanel {...props} />);
  return props;
}

describe("DisplayPanel", () => {
  it("emits the new threshold as a number", () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText("Confidence"), { target: { value: "0.5" } });
    expect(props.onChange).toHaveBeenCalledWith({ ...DEFAULT_VIEW_PARAMS, threshold: 0.5 });
  });

  it("emits the new NMS IoU and the new flicker window", () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText("NMS IoU"), { target: { value: "0.4" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_VIEW_PARAMS, nmsIou: 0.4 });
    fireEvent.change(screen.getByLabelText("Flicker window"), { target: { value: "4" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_VIEW_PARAMS, flickerN: 4 });
  });

  it("shows the sliders' ranges", () => {
    setup();
    expect(screen.getByLabelText("Confidence")).toHaveAttribute("min", "0.05");
    expect(screen.getByLabelText("Confidence")).toHaveAttribute("max", "1");
    expect(screen.getByLabelText("NMS IoU")).toHaveAttribute("min", "0.3");
    expect(screen.getByLabelText("NMS IoU")).toHaveAttribute("max", "0.7");
  });

  it("labels the NMS slider 'off' at 0.70 and shows the number otherwise", () => {
    setup();
    expect(screen.getByText("off")).toBeInTheDocument();
  });

  it("shows the NMS value when it is on", () => {
    setup({ params: { ...DEFAULT_VIEW_PARAMS, nmsIou: 0.5 } });
    expect(screen.queryByText("off")).not.toBeInTheDocument();
    expect(screen.getByText("0.50")).toBeInTheDocument();
  });

  it("calls onReset", async () => {
    const user = userEvent.setup();
    const props = setup();
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(props.onReset).toHaveBeenCalled();
  });

  it("summarises the flicker events with correct pluralisation", () => {
    setup({ blinkCount: 1, dropoutCount: 2 });
    expect(screen.getByText("3 flicker events (1 blink, 2 dropout)")).toBeInTheDocument();
  });

  it("says 'event' for exactly one and 'No flicker events' for none", () => {
    const { unmount } = render(
      <DisplayPanel
        params={DEFAULT_VIEW_PARAMS}
        onChange={vi.fn()}
        onReset={vi.fn()}
        blinkCount={1}
        dropoutCount={0}
        isCoarse={false}
      />,
    );
    expect(screen.getByText("1 flicker event (1 blink, 0 dropout)")).toBeInTheDocument();
    unmount();
    setup();
    expect(screen.getByText("No flicker events")).toBeInTheDocument();
  });

  it("warns when the stride is too coarse for flicker detection", () => {
    setup({ isCoarse: true });
    expect(screen.getByText(/stride is too coarse for flicker detection/i)).toBeInTheDocument();
  });

  it("shows no warning when the stride is fine", () => {
    setup();
    expect(screen.queryByText(/too coarse/i)).not.toBeInTheDocument();
  });
});
