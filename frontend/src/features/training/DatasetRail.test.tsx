import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DatasetRail } from "./DatasetRail";

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

describe("DatasetRail", () => {
  it("lists datasets with task and frame count and disables the ones without an export", () => {
    render(<DatasetRail datasets={datasets} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByRole("option", { name: "polyps-v1 · detection · 110 frames" })).toBeEnabled();
    const draft = screen.getByRole("option", { name: /polyps-v2-draft/ });
    expect(draft).toBeDisabled();
    expect(draft.textContent).toMatch(/export it first/i);
  });

  it("reports the chosen dataset id, and null for the placeholder", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<DatasetRail datasets={datasets} selectedId={null} onSelect={onSelect} />);

    await user.selectOptions(screen.getByLabelText("Dataset"), "1");
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(screen.getByRole("option", { name: "Select a dataset" })).toBeDisabled();
  });

  it("shows the card of the selected dataset with its run count", () => {
    const { rerender } = render(
      <DatasetRail datasets={datasets} selectedId={1} onSelect={vi.fn()} runCount={3} />,
    );
    expect(screen.getByText("3 runs")).toBeInTheDocument();
    expect(screen.getByText("polyp")).toBeInTheDocument();
    rerender(<DatasetRail datasets={datasets} selectedId={1} onSelect={vi.fn()} runCount={1} />);
    expect(screen.getByText("1 run")).toBeInTheDocument();
  });

  it("shows nothing but the select when no dataset is selected", () => {
    render(<DatasetRail datasets={datasets} selectedId={null} onSelect={vi.fn()} runCount={3} />);

    expect(screen.getByLabelText("Dataset")).toHaveValue("");
    expect(screen.queryByText("polyp")).not.toBeInTheDocument();
    expect(screen.queryByText(/runs?$/)).not.toBeInTheDocument();
  });
});
