import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { RunDetail } from "./RunDetail";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
}));

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

const run: TrainingRunRead = {
  id: 4,
  dataset_id: 1,
  job_id: null,
  adapter: "ultralytics",
  base_model: "yolo11n.pt",
  base_model_version_id: null,
  model_version_id: 3,
  name: "my run",
  note: "a note",
  task_type: "detection",
  config: {},
  status: "succeeded",
  stop_requested: false,
  metrics: { "metrics/mAP50(B)": 0.65 },
  current_epoch: 1,
  total_epochs: 1,
  error: null,
  created_at: "2026-08-19T10:00:00Z",
  started_at: "2026-08-19T10:00:00Z",
  finished_at: "2026-08-19T10:02:05Z",
};

function setup(over: Partial<TrainingRunRead> = {}, view: "overview" | "metrics" | "log" | "model" = "overview") {
  const props = {
    onViewChange: vi.fn(),
    onBack: vi.fn(),
    onRepeat: vi.fn(),
    onDeleteRun: vi.fn(),
    onChanged: vi.fn(),
  };
  render(<RunDetail run={{ ...run, ...over }} view={view} schema={null} deleteError={null} {...props} />);
  return props;
}

describe("RunDetail", () => {
  beforeEach(() => {
    vi.mocked(apiClient.PATCH).mockReset().mockResolvedValue({ data: {} } as never);
    vi.mocked(apiClient.GET).mockReset().mockResolvedValue({
      data: { metrics: {}, history: [], per_class: [], confusion: null },
    } as never);
  });

  it("shows the header and goes back", async () => {
    const { onBack } = setup();
    expect(screen.getByText("#4")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("my run");
    expect(screen.getByTitle("Headline metric")).toHaveTextContent("0.650mAP50");
    expect(screen.getByText("2m 05s")).toBeInTheDocument();
    expect(screen.getByText("succeeded")).toHaveClass("bg-green-700");
    await userEvent.click(screen.getByRole("button", { name: "← Runs" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("has tabs with selection and reports clicks", async () => {
    const { onViewChange } = setup({}, "metrics");
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Metrics" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "false");
    await userEvent.click(screen.getByRole("tab", { name: "Log" }));
    expect(onViewChange).toHaveBeenCalledWith("log");
    expect(screen.getByRole("tabpanel")).toBeInTheDocument();
  });

  it("disables Model without a model", () => {
    setup({ model_version_id: null });
    const tab = screen.getByRole("tab", { name: "Model" });
    expect(tab).toBeDisabled();
    expect(tab).toHaveAttribute("title", "This run has no model");
  });

  it("renders the overview panel for the overview view", () => {
    setup();
    expect(screen.getByText("All settings (0)")).toBeInTheDocument();
  });

  it("shows no progress block in the overview of an active run", () => {
    setup({ status: "running", current_epoch: 3, total_epochs: 10, model_version_id: null });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("repeats from the header", async () => {
    const { onRepeat } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Repeat" }));
    expect(onRepeat).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
  });

  it("arms in the menu before deleting the run", async () => {
    const { onDeleteRun } = setup({ model_version_id: null });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Delete run #4" }));
    expect(onDeleteRun).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("menuitem", { name: "Confirm delete run #4" }));
    expect(onDeleteRun).toHaveBeenCalledWith(expect.objectContaining({ id: 4 }));
  });

  it("menu: focus moves in, Escape closes and returns focus and disarms, outside click closes", async () => {
    setup({ model_version_id: null });
    const trigger = screen.getByRole("button", { name: "More actions" });
    await userEvent.click(trigger);
    const item = screen.getByRole("menuitem", { name: "Delete run #4" });
    expect(item).toHaveFocus();
    await userEvent.click(item);
    expect(screen.getByRole("menuitem", { name: "Confirm delete run #4" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await userEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Delete run #4" })).toBeInTheDocument();
    await userEvent.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("disables delete with the reason", async () => {
    setup();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    const del = screen.getByRole("menuitem", { name: "Delete run #4" });
    expect(del).toBeDisabled();
    expect(del).toHaveAttribute("title", "Delete the model first");
  });

  it("disables delete for an active run", async () => {
    setup({ status: "running", model_version_id: null });
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("menuitem", { name: "Delete run #4" })).toHaveAttribute(
      "title",
      "Stop the run first",
    );
  });

  it("shows the delete error", () => {
    const props = { onViewChange: vi.fn(), onBack: vi.fn(), onRepeat: vi.fn(), onDeleteRun: vi.fn(), onChanged: vi.fn() };
    render(<RunDetail run={run} view="overview" schema={null} deleteError="nope" {...props} />);
    expect(screen.getByText("nope")).toHaveAttribute("role", "alert");
  });

  it("saves a changed name on blur, only the name, and not when unchanged", async () => {
    const { onChanged } = setup();
    const input = screen.getByLabelText("Name");
    await userEvent.click(input);
    await userEvent.tab();
    expect(apiClient.PATCH).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, "new");
    await userEvent.tab();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(apiClient.PATCH).toHaveBeenCalledTimes(1);
    expect(apiClient.PATCH).toHaveBeenCalledWith("/training/runs/{run_id}", {
      params: { path: { run_id: 4 } },
      body: { name: "new" },
    });
  });

  it("saves a changed note alone", async () => {
    setup();
    await userEvent.type(screen.getByLabelText("Note"), " more");
    await userEvent.tab();
    await waitFor(() =>
      expect(apiClient.PATCH).toHaveBeenCalledWith("/training/runs/{run_id}", {
        params: { path: { run_id: 4 } },
        body: { note: "a note more" },
      }),
    );
  });

  it("restores the name on Escape without saving", async () => {
    setup();
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    await userEvent.type(input, "zzz");
    await userEvent.keyboard("{Escape}");
    expect(input.value).toBe("my run");
    await userEvent.tab();
    expect(apiClient.PATCH).not.toHaveBeenCalled();
  });

  it("keeps the typed value and alerts when the save fails", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({ error: { detail: "no" } } as never);
    const { onChanged } = setup();
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "bad");
    await userEvent.tab();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(input.value).toBe("bad");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("alerts when the save throws", async () => {
    vi.mocked(apiClient.PATCH).mockRejectedValue(new Error("net"));
    setup();
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    await userEvent.type(input, "x");
    await userEvent.tab();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(input.value).toBe("my runx");
  });

  it("does not overwrite a focused field when the run updates", () => {
    const props = { onViewChange: vi.fn(), onBack: vi.fn(), onRepeat: vi.fn(), onDeleteRun: vi.fn(), onChanged: vi.fn() };
    const { rerender } = render(<RunDetail run={run} view="overview" schema={null} deleteError={null} {...props} />);
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "typing" } });
    rerender(<RunDetail run={{ ...run, name: "server" }} view="overview" schema={null} deleteError={null} {...props} />);
    expect(input.value).toBe("typing");
  });

  it("keeps a saved name until the run catches up, then follows external changes", async () => {
    const props = { onViewChange: vi.fn(), onBack: vi.fn(), onRepeat: vi.fn(), onDeleteRun: vi.fn(), onChanged: vi.fn() };
    const view = (r: TrainingRunRead) => (
      <RunDetail run={r} view="overview" schema={null} deleteError={null} {...props} />
    );
    const { rerender } = render(view(run));
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "saved");
    await userEvent.tab();
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(input.value).toBe("saved");
    rerender(view({ ...run, name: "saved" }));
    expect(input.value).toBe("saved");
    rerender(view({ ...run, name: "external" }));
    expect(input.value).toBe("external");
  });
});
