import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import type { components } from "../../shared/api/generated/schema";
import { RunModelView } from "./RunModelView";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn(), PATCH: vi.fn() },
}));

type TrainingRunRead = components["schemas"]["TrainingRunRead"];
type ModelVersionRead = components["schemas"]["ModelVersionRead"];

const run: TrainingRunRead = {
  id: 7,
  dataset_id: 1,
  job_id: null,
  adapter: "ultralytics",
  base_model: "yolo11n.pt",
  base_model_version_id: null,
  model_version_id: 3,
  name: null,
  note: null,
  task_type: "detection",
  config: {},
  status: "succeeded",
  stop_requested: false,
  metrics: {},
  current_epoch: 2,
  total_epochs: 2,
  error: null,
  created_at: "2026-08-19T10:00:00Z",
  started_at: null,
  finished_at: null,
};

const version: ModelVersionRead = {
  id: 3,
  training_run_id: 7,
  name: "yolo11n-run7",
  task_type: "detection",
  metrics: { "metrics/mAP50(B)": 0.712 },
  is_active: false,
  base_model: "yolo11n.pt",
  base_model_version_id: null,
  created_at: "2026-08-19T10:00:00Z",
};

function mockGets() {
  vi.mocked(apiClient.GET).mockImplementation((async (path: string) => {
    if (path === "/training/models") return { data: [{ ...version, id: 99, name: "other" }, version] };
    if (path === "/training/models/{version_id}/metrics") {
      return {
        data: {
          metrics: {},
          history: [],
          per_class: [],
          confusion: null,
          artifacts: [{ name: "results.csv", index: 0 }],
        },
      };
    }
    if (path === "/training/models/{version_id}/download") {
      return { data: { download_url: "http://minio/model.pt" } };
    }
    return { data: undefined };
  }) as never);
}

describe("RunModelView", () => {
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockReset();
    vi.mocked(apiClient.DELETE).mockReset();
  });

  it("explains when the run has no model", () => {
    render(<RunModelView run={{ ...run, model_version_id: null }} onChanged={() => {}} />);
    expect(
      screen.getByText(
        "This run has no model (it failed, was stopped before the first epoch, or its model was deleted)",
      ),
    ).toBeInTheDocument();
    expect(apiClient.GET).not.toHaveBeenCalled();
  });

  it("shows the model's name, task, score and artifacts", async () => {
    mockGets();
    render(<RunModelView run={run} onChanged={() => {}} />);

    expect(await screen.findByText("yolo11n-run7")).toBeInTheDocument();
    expect(screen.getByText(/detection/)).toBeInTheDocument();
    expect(screen.getByText(/0\.712/)).toBeInTheDocument();
    expect(await screen.findByText("results.csv")).toBeInTheDocument();
  });

  it("downloads through a presigned URL", async () => {
    mockGets();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<RunModelView run={run} onChanged={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Download model yolo11n-run7" }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("http://minio/model.pt", "_blank", "noopener,noreferrer"),
    );
    open.mockRestore();
  });

  it("arms before deleting, then calls onChanged on success", async () => {
    mockGets();
    vi.mocked(apiClient.DELETE).mockResolvedValue({ response: { status: 204 } } as never);
    const onChanged = vi.fn();
    render(<RunModelView run={run} onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete model yolo11n-run7" }));
    expect(apiClient.DELETE).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete model yolo11n-run7" }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(apiClient.DELETE).toHaveBeenCalledWith("/training/models/{version_id}", {
      params: { path: { version_id: 3 } },
    });
  });

  it("shows the server's message on a 409 and does not call onChanged", async () => {
    mockGets();
    vi.mocked(apiClient.DELETE).mockResolvedValue({
      error: { detail: "Model is used as a base by another run." },
      response: { status: 409 },
    } as never);
    const onChanged = vi.fn();
    render(<RunModelView run={run} onChanged={onChanged} />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete model yolo11n-run7" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete model yolo11n-run7" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Model is used as a base by another run.");
    expect(onChanged).not.toHaveBeenCalled();
  });
});
