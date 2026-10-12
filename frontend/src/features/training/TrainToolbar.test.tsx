import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TrainToolbar } from "./TrainToolbar";

const dataset = (id: number, name: string, exported: boolean) => ({
  id,
  name,
  exported,
  taskType: "detection",
  itemCount: 110,
  splitCounts: { train: 80, val: 20, test: 10 },
  classes: [{ name: "polyp", instances: 40 }],
});
const datasets = [dataset(1, "polyps-v1", true), dataset(2, "polyps-v2-draft", false)];

function setup(over: Partial<React.ComponentProps<typeof TrainToolbar>> = {}) {
  const handlers = { onSelect: vi.fn(), onNewRun: vi.fn(), onCloseForm: vi.fn() };
  render(
    <TrainToolbar datasets={datasets} selectedId={1} runCount={3} formOpen={false} {...handlers} {...over} />,
  );
  return handlers;
}

describe("TrainToolbar", () => {
  it("lists datasets and disables the ones without an export, with the reason", () => {
    setup();
    expect(screen.getByRole("option", { name: "polyps-v1 · detection · 110 frames" })).toBeEnabled();
    const draft = screen.getByRole("option", { name: /polyps-v2-draft/ });
    expect(draft).toBeDisabled();
    expect(draft.textContent).toMatch(/export it first/i);
  });

  it("reports the chosen dataset id and disables the placeholder", async () => {
    const { onSelect } = setup({ selectedId: null });
    await userEvent.setup().selectOptions(screen.getByLabelText("Dataset"), "1");
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(screen.getByRole("option", { name: "Select a dataset" })).toBeDisabled();
  });

  it("shows the one-line summary and run count of the selected dataset", () => {
    setup();
    expect(screen.getByText("detection · 110 frames · train 80 / val 20 / test 10")).toBeInTheDocument();
    expect(screen.getByText("3 runs")).toBeInTheDocument();
  });

  it("shows no summary and a disabled button without a dataset", () => {
    setup({ selectedId: null });
    expect(screen.getByLabelText("Dataset")).toHaveValue("");
    expect(screen.queryByText(/frames ·/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+ runs?$/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New run" })).toBeDisabled();
  });

  it("+ New run opens the form; while it is open the button is ← Runs and closes it", () => {
    const { onNewRun, onCloseForm } = setup();
    fireEvent.click(screen.getByRole("button", { name: "+ New run" }));
    expect(onNewRun).toHaveBeenCalledTimes(1);
    expect(onCloseForm).not.toHaveBeenCalled();
  });

  it("closes the form from ← Runs", () => {
    const { onNewRun, onCloseForm } = setup({ formOpen: true });
    expect(screen.queryByRole("button", { name: "+ New run" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "← Runs" }));
    expect(onCloseForm).toHaveBeenCalledTimes(1);
    expect(onNewRun).not.toHaveBeenCalled();
  });

  it("keeps ← Runs enabled with the form open and no dataset selected", () => {
    const { onCloseForm } = setup({ selectedId: null, formOpen: true });
    const back = screen.getByRole("button", { name: "← Runs" });
    expect(back).toBeEnabled();
    fireEvent.click(back);
    expect(onCloseForm).toHaveBeenCalledTimes(1);
  });
});
