import { fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(screen.getByText("No runs on this dataset yet. Start one with the + New run button.")).toBeInTheDocument();
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
    expect(screen.queryByText("tried larger frames")).not.toBeInTheDocument();
    expect(screen.getByText("#1").closest("td")).toHaveAttribute("title", "tried larger frames");
    expect(screen.getByText("big frames").className).toContain("truncate");
    expect(screen.queryByRole("columnheader", { name: "Name" })).not.toBeInTheDocument();
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

  const openMenu = (id: number) =>
    fireEvent.click(screen.getByRole("button", { name: `More actions for run ${id}` }));

  it("opens a run from a click on its row; there is no Open button", () => {
    const { onOpen } = setup([run({ id: 4 })]);
    expect(screen.queryByRole("button", { name: /Open run/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("#4"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(4);
    fireEvent.keyDown(screen.getByText("#4").closest("tr")!, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("repeats with changes without opening the row", () => {
    const r = run({ id: 5 });
    const { onRepeat, onOpen } = setup([r]);
    fireEvent.click(screen.getByRole("button", { name: "Repeat run 5 with changes" }));
    expect(onRepeat).toHaveBeenCalledWith(r);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("arms inside the ⋯ menu before deleting", () => {
    const r = run({ id: 6 });
    const { onDelete, onOpen } = setup([r]);
    expect(screen.queryByRole("button", { name: "Delete run 6" })).not.toBeInTheDocument();
    openMenu(6);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete run 6" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Confirm delete run 6" }));
    expect(onDelete).toHaveBeenCalledWith(r);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("menu is keyboard operable: aria-haspopup, Escape closes and returns focus, and disarms", () => {
    setup([run({ id: 6 })]);
    const trigger = screen.getByRole("button", { name: "More actions for run 6" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const item = screen.getByRole("menuitem", { name: "Delete run 6" });
    expect(item).toHaveFocus();
    fireEvent.click(item);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Delete run 6" })).toBeInTheDocument();
  });

  it("closes the menu on an outside click", () => {
    setup([run({ id: 6 })]);
    openMenu(6);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("a click on the menu panel itself does not open the row", () => {
    const { onOpen } = setup([run({ id: 6 })]);
    openMenu(6);
    fireEvent.click(screen.getByRole("menu"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("closes and disarms the menu when the runs list changes", () => {
    const { rerender, onOpen, onRepeat, onDelete } = setup([run({ id: 6 }), run({ id: 7 })]);
    openMenu(7);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete run 7" }));
    expect(screen.getByRole("menuitem", { name: "Confirm delete run 7" })).toBeInTheDocument();
    rerender(
      <RunsTable runs={[run({ id: 7 })]} selectedRunId={null} loading={false} error={null}
        deleteError={null} onOpen={onOpen} onRepeat={onRepeat} onDelete={onDelete} />,
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    openMenu(7);
    expect(screen.getByRole("menuitem", { name: "Delete run 7" })).toBeInTheDocument();
  });

  it("disables Delete for a run that owns a model and for an active run, with the reason", () => {
    setup([
      run({ id: 1, model_version_id: 9 }),
      run({ id: 2, status: "running", finished_at: null }),
      run({ id: 3, status: "pending", started_at: null, finished_at: null }),
    ]);
    openMenu(1);
    const owns = screen.getByTitle("Delete the model first");
    expect(owns).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    openMenu(2);
    expect(screen.getByTitle("Stop the run first")).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    openMenu(3);
    expect(screen.getByTitle("Stop the run first")).toBeDisabled();
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
      expect(screen.getByRole("button", { name: `Repeat run ${id} with changes` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `More actions for run ${id}` })).toBeInTheDocument();
    }
    openMenu(2);
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete run 2" })).toBeInTheDocument();
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

    it("keeps a selected unfinished run's checkbox enabled so it can be unticked", () => {
      const onToggleCompare = vi.fn();
      setup([run({ id: 2, status: "running", finished_at: null })], {
        selectedForCompare: [2],
        onToggleCompare,
      });
      const box = screen.getByRole("checkbox", { name: "Select run 2 for comparison" });
      expect(box).toBeEnabled();
      fireEvent.click(box);
      expect(onToggleCompare).toHaveBeenCalledWith(2);
    });

    it("does not open the row when the checkbox cell padding is clicked", () => {
      const { onOpen } = setup([run({ id: 1 })]);
      const cell = screen.getByRole("checkbox", { name: "Select run 1 for comparison" }).closest("td")!;
      fireEvent.click(cell);
      expect(onOpen).not.toHaveBeenCalled();
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

    it("hides the compare bar with nothing ticked", () => {
      setup([run({ id: 1 }), run({ id: 2 })]);
      expect(screen.queryByRole("button", { name: "Compare" })).not.toBeInTheDocument();
      expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    });

    it("with 1 ticked shows the bar with Compare disabled", () => {
      setup([run({ id: 1 }), run({ id: 2 })], { selectedForCompare: [1] });
      expect(screen.getByText("1 selected")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Compare" })).toBeDisabled();
    });

    it("with 2 or 3 ticked enables Compare and calls onCompare", () => {
      const onCompare = vi.fn();
      const { onOpen } = setup([run({ id: 1 }), run({ id: 2 }), run({ id: 3 })], {
        selectedForCompare: [1, 2, 3],
        onCompare,
      });
      expect(screen.getByText("3 selected")).toBeInTheDocument();
      const button = screen.getByRole("button", { name: "Compare" });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(onCompare).toHaveBeenCalledTimes(1);
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("Clear calls onClearCompare, or unticks each run when no handler is given", () => {
      const onClearCompare = vi.fn();
      const { unmount } = setup([run({ id: 1 }), run({ id: 2 })], {
        selectedForCompare: [1, 2],
        onClearCompare,
      });
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(onClearCompare).toHaveBeenCalledTimes(1);
      unmount();
      const onToggleCompare = vi.fn();
      setup([run({ id: 1 }), run({ id: 2 })], { selectedForCompare: [1, 2], onToggleCompare });
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
      expect(onToggleCompare.mock.calls).toEqual([[1], [2]]);
    });

    it("uses dark checkboxes", () => {
      setup([run({ id: 1 })]);
      const cls = screen.getByRole("checkbox").className;
      expect(cls).toContain("accent-blue-500");
      expect(cls).toContain("[color-scheme:dark]");
    });
  });
});
