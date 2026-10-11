import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { components } from "../../shared/api/generated/schema";
import { RunsTable } from "./RunsTable";

type Run = components["schemas"]["TrainingRunRead"];

const base = {
  id: 1, dataset_id: 496, status: "succeeded", task_type: "detection", name: null, note: null,
  base_model: "yolo11n.pt", base_model_version_id: null, model_version_id: null,
  config: { imgsz: 640, batch: 4, epochs: 50 }, metrics: { "metrics/mAP50(B)": 0.5 },
  started_at: "2026-10-09T10:00:00Z", finished_at: "2026-10-09T10:01:05Z",
  created_at: "2026-10-09T09:59:00Z", current_epoch: 50, total_epochs: 50, error: null,
} as unknown as Run;

function run(over: Partial<Run>): Run {
  return { ...base, ...over } as Run;
}

function setup(runs: Run[], props: Partial<React.ComponentProps<typeof RunsTable>> = {}) {
  const handlers = { onOpen: vi.fn(), onRepeat: vi.fn(), onDelete: vi.fn() };
  const utils = render(
    <RunsTable
      runs={runs}
      selectedRunId={null}
      loading={false}
      error={null}
      deleteError={null}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...utils };
}

describe("RunsTable", () => {
  it("shows an empty state, a loading state and an error instead of a blank table", () => {
    const { rerender, onOpen, onRepeat, onDelete } = setup([]);
    expect(screen.getByText("No runs on this dataset yet. Start one from the New run tab.")).toBeInTheDocument();
    const common = { runs: [], selectedRunId: null, deleteError: null, onOpen, onRepeat, onDelete };
    rerender(<RunsTable {...common} loading={true} error={null} />);
    expect(screen.queryByText(/No runs on this dataset yet/)).not.toBeInTheDocument();
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    rerender(<RunsTable {...common} loading={false} error="Could not load runs" />);
    expect(screen.getByText("Could not load runs")).toBeInTheDocument();
    expect(screen.queryByText(/No runs on this dataset yet/)).not.toBeInTheDocument();
  });

  it("renders id, name with its note, base, settings line, status, metric and duration", () => {
    setup([run({ name: "big frames", note: "tried larger frames" })]);
    expect(screen.getByText("#1")).toBeInTheDocument();
    expect(screen.getByText("big frames")).toBeInTheDocument();
    const note = screen.getByText("tried larger frames");
    expect(note).toHaveAttribute("title", "tried larger frames");
    expect(note.className).toContain("truncate");
    expect(screen.getByText("yolo11n.pt")).toBeInTheDocument();
    expect(screen.getByText("640 · b4 · 50 ep")).toBeInTheDocument();
    expect(screen.getByText("succeeded")).toBeInTheDocument();
    expect(screen.getByText("0.500")).toBeInTheDocument();
    expect(screen.getByText("1m 05s")).toBeInTheDocument();
  });

  it("marks a fine-tune with the parent", () => {
    setup([run({ base_model: "parent-model", base_model_version_id: 3 })]);
    expect(screen.getByText("↳ parent-model")).toBeInTheDocument();
  });

  it("emphasises only the best run's metric", () => {
    setup([
      run({ id: 1, metrics: { "metrics/mAP50(B)": 0.3 } }),
      run({ id: 2, metrics: { "metrics/mAP50(B)": 0.7 } }),
    ]);
    const best = screen.getAllByTitle("Best on this dataset");
    expect(best).toHaveLength(1);
    expect(best[0]).toHaveTextContent("0.700");
    expect(best[0].className).toContain("font-semibold");
  });

  it("opens a run from the Open button and from a click on the row", () => {
    const { onOpen } = setup([run({ id: 4 })]);
    fireEvent.click(screen.getByRole("button", { name: "Open run 4" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(4);
    fireEvent.click(screen.getByText("#4"));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("repeats with changes", () => {
    const r = run({ id: 5 });
    const { onRepeat, onOpen } = setup([r]);
    fireEvent.click(screen.getByRole("button", { name: "Repeat run 5 with changes" }));
    expect(onRepeat).toHaveBeenCalledWith(r);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("arms before deleting", () => {
    const r = run({ id: 6 });
    const { onDelete, onOpen } = setup([r]);
    fireEvent.click(screen.getByRole("button", { name: "Delete run 6" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete run 6" }));
    expect(onDelete).toHaveBeenCalledWith(r);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("disarms when the runs change", () => {
    const r = run({ id: 6 });
    const { rerender, onOpen, onRepeat, onDelete } = setup([r]);
    fireEvent.click(screen.getByRole("button", { name: "Delete run 6" }));
    expect(screen.getByRole("button", { name: "Confirm delete run 6" })).toBeInTheDocument();
    rerender(
      <RunsTable runs={[r, run({ id: 7 })]} selectedRunId={null} loading={false} error={null}
        deleteError={null} onOpen={onOpen} onRepeat={onRepeat} onDelete={onDelete} />,
    );
    expect(screen.queryByRole("button", { name: "Confirm delete run 6" })).not.toBeInTheDocument();
  });

  it("disables Delete for a run that owns a model and for an active run, with the reason", () => {
    setup([
      run({ id: 1, model_version_id: 9 }),
      run({ id: 2, status: "running", finished_at: null }),
      run({ id: 3, status: "pending", started_at: null, finished_at: null }),
    ]);
    const owns = screen.getByTitle("Delete the model first");
    expect(owns).toBeDisabled();
    const active = screen.getAllByTitle("Stop the run first");
    expect(active).toHaveLength(2);
    active.forEach((b) => expect(b).toBeDisabled());
  });

  it("highlights the selected row", () => {
    setup([run({ id: 1 }), run({ id: 2 })], { selectedRunId: 2 });
    const rows = screen.getAllByRole("row").filter((r) => r.hasAttribute("aria-current"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).toHaveTextContent("#2");
  });

  it("shows the delete error", () => {
    setup([run({})], { deleteError: "Run 1 could not be deleted" });
    expect(screen.getByRole("alert")).toHaveTextContent("Run 1 could not be deleted");
  });

  it("gives each row's actions a distinct accessible name", () => {
    setup([run({ id: 1 }), run({ id: 2 })]);
    for (const id of [1, 2]) {
      expect(screen.getByRole("button", { name: `Open run ${id}` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Repeat run ${id} with changes` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Delete run ${id}` })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: "Delete run 2" }));
    expect(screen.getByRole("button", { name: "Confirm delete run 2" })).toBeInTheDocument();
  });
  describe("selection for comparison", () => {
    it("renders a checkbox per row and toggles without opening the row", () => {
      const onToggleCompare = vi.fn();
      const { onOpen } = setup([run({ id: 1 }), run({ id: 2 })], { onToggleCompare });
      expect(screen.getByRole("checkbox", { name: "Select run 1 for comparison" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("checkbox", { name: "Select run 2 for comparison" }));
      expect(onToggleCompare).toHaveBeenCalledWith(2);
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("disables the checkbox of runs that are not finished, with the reason", () => {
      setup([
        run({ id: 1, status: "failed" }),
        run({ id: 2, status: "running", finished_at: null }),
        run({ id: 3, status: "pending", started_at: null, finished_at: null }),
        run({ id: 4, status: "stopped" }),
      ]);
      for (const id of [1, 2, 3]) {
        const box = screen.getByRole("checkbox", { name: `Select run ${id} for comparison` });
        expect(box).toBeDisabled();
        expect(box).toHaveAttribute("title", "Only finished runs can be compared");
      }
      expect(screen.getByRole("checkbox", { name: "Select run 4 for comparison" })).toBeEnabled();
    });

    it("with 3 selected, disables the unselected boxes but keeps the selected ones enabled", () => {
      setup([run({ id: 1 }), run({ id: 2 }), run({ id: 3 }), run({ id: 4 })], {
        selectedForCompare: [1, 2, 3],
      });
      for (const id of [1, 2, 3]) {
        const box = screen.getByRole("checkbox", { name: `Select run ${id} for comparison` });
        expect(box).toBeChecked();
        expect(box).toBeEnabled();
      }
      const fourth = screen.getByRole("checkbox", { name: "Select run 4 for comparison" });
      expect(fourth).not.toBeChecked();
      expect(fourth).toBeDisabled();
      expect(fourth).toHaveAttribute("title", "You can compare up to 3 runs");
    });

    it("shows the hint and keeps Compare disabled with 0 or 1 selected", () => {
      const { rerender, onOpen, onRepeat, onDelete } = setup([run({ id: 1 }), run({ id: 2 })]);
      expect(screen.getByText("Select 2–3 runs of this dataset.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Compare (0)" })).toBeDisabled();
      rerender(
        <RunsTable runs={[run({ id: 1 }), run({ id: 2 })]} selectedRunId={null} loading={false}
          error={null} deleteError={null} onOpen={onOpen} onRepeat={onRepeat} onDelete={onDelete}
          selectedForCompare={[1]} />,
      );
      expect(screen.getByRole("button", { name: "Compare (1)" })).toBeDisabled();
    });

    it("enables Compare with 2 or 3 selected, shows the count and calls onCompare", () => {
      const onCompare = vi.fn();
      const { rerender, onOpen, onRepeat, onDelete } = setup(
        [run({ id: 1 }), run({ id: 2 }), run({ id: 3 })],
        { selectedForCompare: [1, 2], onCompare },
      );
      const button = screen.getByRole("button", { name: "Compare (2)" });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(onCompare).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
      rerender(
        <RunsTable runs={[run({ id: 1 }), run({ id: 2 }), run({ id: 3 })]} selectedRunId={null}
          loading={false} error={null} deleteError={null} onOpen={onOpen} onRepeat={onRepeat}
          onDelete={onDelete} selectedForCompare={[1, 2, 3]} onCompare={onCompare} />,
      );
      expect(screen.getByRole("button", { name: "Compare (3)" })).toBeEnabled();
    });
  });
});
