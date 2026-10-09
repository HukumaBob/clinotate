import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { RunOverview } from "./RunOverview";
import { settingsSchemaFixture } from "./testFixtures";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
}));

type TrainingRunRead = components["schemas"]["TrainingRunRead"];

const run: TrainingRunRead = {
  id: 1,
  dataset_id: 1,
  job_id: null,
  adapter: "ultralytics",
  base_model: "yolo11n.pt",
  base_model_version_id: null,
  model_version_id: null,
  name: "first",
  note: "a note",
  task_type: "detection",
  config: { epochs: 80, batch: 8, mystery: "x" },
  status: "succeeded",
  stop_requested: false,
  metrics: { "metrics/mAP50(B)": 0.65, label: "text" },
  current_epoch: 80,
  total_epochs: 80,
  error: null,
  created_at: "2026-08-19T10:00:00Z",
  started_at: null,
  finished_at: null,
};

const metricsBody = {
  metrics: {},
  history: [
    { epoch: 1, "train/loss": 1.0 },
    { epoch: 2, "train/loss": 0.6 },
  ],
  per_class: [],
  confusion: null,
};

function renderOverview(over: Partial<TrainingRunRead> = {}, props: Record<string, unknown> = {}) {
  const handlers = { onRepeat: vi.fn(), onDeleteRun: vi.fn(), onChanged: vi.fn() };
  render(
    <RunOverview
      run={{ ...run, ...over }}
      schema={settingsSchemaFixture}
      deleteError={null}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe("RunOverview", () => {
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockReset().mockResolvedValue({ data: metricsBody } as never);
    vi.mocked(apiClient.PATCH).mockReset().mockResolvedValue({ data: {} } as never);
  });

  it("groups settings by schema, emphasising non-default values with the default", () => {
    renderOverview();
    expect(screen.getByText("Basic")).toBeInTheDocument();
    const epochs = screen.getByText("80");
    expect(epochs).toHaveClass("text-blue-300");
    expect(screen.getByText("(default 50)")).toBeInTheDocument();
    const batch = screen.getByText("8", { selector: "dd" });
    expect(batch).not.toHaveClass("text-blue-300");
  });

  it("lists unknown keys raw and works without a schema", () => {
    renderOverview();
    expect(screen.getByText("Other settings")).toBeInTheDocument();
    expect(screen.getByText("mystery")).toBeInTheDocument();
  });

  it("with no schema shows one flat Settings list of raw keys", () => {
    renderOverview({}, { schema: null });
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("epochs")).toBeInTheDocument();
    expect(screen.getByText("mystery")).toBeInTheDocument();
    expect(screen.queryByText("Basic")).not.toBeInTheDocument();
  });

  it("saves a changed name on blur, only the name, and not when unchanged", async () => {
    const { onChanged } = renderOverview();
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
      params: { path: { run_id: 1 } },
      body: { name: "new" },
    });
  });

  it("saves a changed note alone", async () => {
    renderOverview();
    const note = screen.getByLabelText("Note");
    await userEvent.type(note, " more");
    await userEvent.tab();
    await waitFor(() =>
      expect(apiClient.PATCH).toHaveBeenCalledWith("/training/runs/{run_id}", {
        params: { path: { run_id: 1 } },
        body: { note: "a note more" },
      }),
    );
  });

  it("restores the name on Escape without saving", async () => {
    renderOverview();
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    await userEvent.type(input, "zzz");
    await userEvent.keyboard("{Escape}");
    expect(input.value).toBe("first");
    await userEvent.tab();
    expect(apiClient.PATCH).not.toHaveBeenCalled();
  });

  it("keeps the typed value and alerts when the save fails", async () => {
    vi.mocked(apiClient.PATCH).mockResolvedValue({ error: { detail: "no" } } as never);
    const { onChanged } = renderOverview();
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
    renderOverview();
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    await userEvent.type(input, "x");
    await userEvent.tab();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(input.value).toBe("firstx");
  });

  it("shows the error, and progress only for an active run", () => {
    const { unmount } = render(
      <RunOverview
        run={{ ...run, status: "running", current_epoch: 3, total_epochs: 10, error: "boom" }}
        schema={null}
        deleteError={null}
        onRepeat={vi.fn()}
        onDeleteRun={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByText("Epoch 3 / 10")).toBeInTheDocument();
    unmount();
    renderOverview();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("lists the numeric final metrics only", () => {
    renderOverview();
    expect(screen.getByText("metrics/mAP50(B)")).toBeInTheDocument();
    expect(screen.getByText("0.65")).toBeInTheDocument();
    expect(screen.queryByText("text")).not.toBeInTheDocument();
  });

  it("draws the training curve", async () => {
    renderOverview();
    await waitFor(() => expect(document.querySelectorAll("path[data-series]").length).toBeGreaterThan(0));
  });

  it("repeats with changes", async () => {
    const { onRepeat } = renderOverview();
    await userEvent.click(screen.getByRole("button", { name: "Repeat with changes" }));
    expect(onRepeat).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("arms before deleting the run", async () => {
    const { onDeleteRun } = renderOverview();
    await userEvent.click(screen.getByRole("button", { name: "Delete run #1" }));
    expect(onDeleteRun).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete run #1" }));
    expect(onDeleteRun).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });

  it("disables delete with the reason", () => {
    renderOverview({ model_version_id: 3 });
    const button = screen.getByRole("button", { name: "Delete run #1" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Delete the model first");
  });

  it("disables delete for an active run", () => {
    renderOverview({ status: "running" });
    expect(screen.getByRole("button", { name: "Delete run #1" })).toHaveAttribute(
      "title",
      "Stop the run first",
    );
  });

  it("shows the delete error", () => {
    renderOverview({}, { deleteError: "nope" });
    expect(screen.getByText("nope")).toHaveAttribute("role", "alert");
  });

  it("does not overwrite a focused field when the run updates", () => {
    const { rerender } = render(
      <RunOverview run={run} schema={null} deleteError={null} onRepeat={vi.fn()} onDeleteRun={vi.fn()} onChanged={vi.fn()} />,
    );
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "typing" } });
    rerender(
      <RunOverview run={{ ...run, name: "server" }} schema={null} deleteError={null} onRepeat={vi.fn()} onDeleteRun={vi.fn()} onChanged={vi.fn()} />,
    );
    expect(input.value).toBe("typing");
  });

  it("keeps a saved name until the run catches up, then follows external changes", async () => {
    const props = { schema: null, deleteError: null, onRepeat: vi.fn(), onDeleteRun: vi.fn(), onChanged: vi.fn() };
    const { rerender } = render(<RunOverview run={run} {...props} />);
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "saved");
    await userEvent.tab();
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(input.value).toBe("saved");
    rerender(<RunOverview run={{ ...run, name: "saved" }} {...props} />);
    expect(input.value).toBe("saved");
    rerender(<RunOverview run={{ ...run, name: "external" }} {...props} />);
    expect(input.value).toBe("external");
  });

  it("hides setting groups with no value in an old-style config", () => {
    renderOverview({ config: { epochs: 50, batch: 8, imgsz: 640 } });
    expect(screen.getByText("Basic")).toBeInTheDocument();
    expect(screen.queryByText("Optimization")).not.toBeInTheDocument();
  });

  it("shows every group present in a full config", () => {
    const config: Record<string, unknown> = {};
    for (const group of settingsSchemaFixture.groups)
      for (const field of group.fields) config[field.key] = field.default;
    renderOverview({ config });
    for (const group of settingsSchemaFixture.groups)
      expect(screen.getByText(group.label)).toBeInTheDocument();
  });

  it("rounds numeric final metrics to 4 decimals with the full value in the title", () => {
    renderOverview({ metrics: { "metrics/mAP50(B)": 0.8974314322666428 } });
    const cell = screen.getByText("0.8974");
    expect(cell).toHaveAttribute("title", "0.8974314322666428");
  });
});
