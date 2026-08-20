import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TrainPage } from "./TrainPage";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

const { apiClient } = await import("../../shared/api/client");

describe("TrainPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/datasets") {
        return { data: [{ id: 1, name: "polyps-v1", task_type: "detection", exported: true }] };
      }
      if (path === "/training/runs") {
        return { data: [] };
      }
      if (path === "/training/models") {
        return { data: [] };
      }
      return { data: null };
    });
  });

  it("renders the YOLO tab and the config form", async () => {
    render(<TrainPage />);

    expect(await screen.findByRole("tab", { name: /yolo/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /yolo/i })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("button", { name: /start training/i })).toBeInTheDocument();
  });

  it("shows the empty run state when no run exists", async () => {
    render(<TrainPage />);

    expect(await screen.findByText(/no training run/i)).toBeInTheDocument();
  });

  it("polls the log while a run is active", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/datasets") {
        return { data: [{ id: 1, name: "polyps-v1", task_type: "detection", exported: true }] };
      }
      if (path === "/training/runs") {
        return {
          data: [
            {
              id: 7,
              status: "running",
              current_epoch: 1,
              total_epochs: 10,
              stop_requested: false,
              error: null,
              metrics: {},
            },
          ],
        };
      }
      if (path === "/training/runs/{run_id}") {
        return {
          data: {
            id: 7,
            status: "running",
            current_epoch: 1,
            total_epochs: 10,
            stop_requested: false,
            error: null,
            metrics: {},
          },
        };
      }
      if (path === "/training/runs/{run_id}/log") {
        return { data: { text: "epoch 1/10\n", offset: 12, status: "running" } };
      }
      return { data: [] };
    });

    render(<TrainPage />);

    // Let the initial mount's fetches (datasets/runs/models) settle before
    // advancing the poll interval, so the active run is already in state
    // when the interval tick fires.
    await vi.waitFor(() => screen.getByText(/running/i));

    await vi.advanceTimersByTimeAsync(2100);

    expect(vi.mocked(apiClient.GET)).toHaveBeenCalledWith(
      "/training/runs/{run_id}/log",
      expect.objectContaining({
        params: expect.objectContaining({ path: { run_id: 7 } }),
      }),
    );
    vi.useRealTimers();
  });

  it("stops polling once the run reaches a terminal status", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let runStatus = "running";
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/datasets") {
        return { data: [{ id: 1, name: "polyps-v1", task_type: "detection", exported: true }] };
      }
      if (path === "/training/runs") {
        return {
          data: [
            {
              id: 7,
              status: runStatus,
              current_epoch: 1,
              total_epochs: 10,
              stop_requested: false,
              error: null,
              metrics: {},
            },
          ],
        };
      }
      if (path === "/training/runs/{run_id}") {
        return {
          data: {
            id: 7,
            status: runStatus,
            current_epoch: 1,
            total_epochs: 10,
            stop_requested: false,
            error: null,
            metrics: {},
          },
        };
      }
      if (path === "/training/models") {
        return { data: [] };
      }
      if (path === "/training/runs/{run_id}/log") {
        return { data: { text: "epoch 1/10\n", offset: 12, status: runStatus } };
      }
      return { data: [] };
    });

    render(<TrainPage />);

    await vi.waitFor(() => screen.getByText(/running/i));

    await vi.advanceTimersByTimeAsync(2100);

    expect(vi.mocked(apiClient.GET)).toHaveBeenCalledWith(
      "/training/runs/{run_id}/log",
      expect.anything(),
    );

    runStatus = "succeeded";
    const callCountAtTerminal = vi.mocked(apiClient.GET).mock.calls.length;

    await vi.advanceTimersByTimeAsync(2100);
    await vi.advanceTimersByTimeAsync(2100);

    // Allow at most one more in-flight tick to land after the status
    // flipped, but no further growth after that -- the interval must stop.
    const callCountShortlyAfter = vi.mocked(apiClient.GET).mock.calls.length;
    await vi.advanceTimersByTimeAsync(2100);
    const callCountLater = vi.mocked(apiClient.GET).mock.calls.length;

    expect(callCountLater).toBe(callCountShortlyAfter);
    expect(callCountShortlyAfter).toBeGreaterThanOrEqual(callCountAtTerminal);

    vi.useRealTimers();
  });
});
