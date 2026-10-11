import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CompareView } from "./CompareView";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

const { apiClient } = await import("../../shared/api/client");

const run = (id: number, name: string | null = null) =>
  ({
    id,
    dataset_id: 496,
    status: "succeeded",
    task_type: "detection",
    name,
    note: null,
    base_model: "yolo11n.pt",
    base_model_version_id: null,
    model_version_id: null,
    config: { epochs: id * 10 },
    metrics: {},
    current_epoch: 1,
    total_epochs: 1,
  }) as never;

const body = (map: number) => ({
  metrics: { mAP50: map },
  history: [
    { epoch: 1, mAP50: map / 2 },
    { epoch: 2, mAP50: map },
  ],
  per_class: [{ class: "polyp", precision: map }],
  confusion: { labels: ["polyp", "ulcer"], matrix: [[3, 1], [0, 4]] },
});

let failing: number[];

beforeEach(() => {
  vi.clearAllMocks();
  failing = [];
  vi.mocked(apiClient.GET).mockImplementation((async (
    _path: string,
    opts: { params: { path: { run_id: number } } },
  ) => {
    const id = opts.params.path.run_id;
    if (failing.includes(id)) return { data: undefined, error: { detail: "boom" } };
    return { data: body(id / 10) };
  }) as never);
});

describe("CompareView", () => {
  it("shows a loading line, then the curves, tables and confusion sections in order", async () => {
    render(<CompareView runs={[run(1, "a"), run(2)]} schema={null} onBack={() => {}} onRemove={() => {}} />);
    expect(screen.getByText("Loading metrics…")).toBeInTheDocument();
    const confusion = await screen.findByRole("heading", { name: "Confusion matrices" });
    expect(screen.queryByText("Loading metrics…")).not.toBeInTheDocument();
    const tables = screen.getByRole("heading", { name: "Final metrics" });
    const curves = screen.getAllByRole("combobox")[0];
    expect(curves.compareDocumentPosition(tables) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tables.compareDocumentPosition(confusion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Comparing #1 a, #2")).toBeInTheDocument();
  });

  it("calls onBack from the back button and onRemove from a chip", async () => {
    const onBack = vi.fn();
    const onRemove = vi.fn();
    render(<CompareView runs={[run(1), run(2), run(3)]} schema={null} onBack={onBack} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole("button", { name: /← Runs/ }));
    expect(onBack).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Remove run 2 from the comparison" }));
    expect(onRemove).toHaveBeenCalledWith(2);
  });

  it("names a run whose metrics failed to load and still renders the others", async () => {
    failing = [2];
    render(<CompareView runs={[run(1), run(2, "bad")]} schema={null} onBack={() => {}} onRemove={() => {}} />);
    expect(await screen.findByText(/Could not load metrics for #2 bad/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Final metrics" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Confusion matrices" })).toBeInTheDocument();
  });
});
