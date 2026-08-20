import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("requests the next log poll starting at the offset the previous poll returned", async () => {
    // The incremental log endpoint exists specifically so the client never
    // re-fetches the whole (potentially multi-megabyte) log on every poll.
    // A regression that always sends offset 0 (or omits it) would defeat
    // that, and the earlier "polls the log" test -- which only asserts the
    // run_id, not the offset -- would not catch it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let logOffset = 12;
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
        const text = `epoch chunk at offset ${logOffset}\n`;
        const responseOffset = logOffset + text.length;
        logOffset = responseOffset;
        return { data: { text, offset: responseOffset, status: "running" } };
      }
      return { data: [] };
    });

    render(<TrainPage />);

    await vi.waitFor(() => screen.getByText(/running/i));

    await vi.advanceTimersByTimeAsync(2100);

    const firstPollOffset = logOffset; // the offset the first poll returned

    await vi.advanceTimersByTimeAsync(2100);

    expect(vi.mocked(apiClient.GET)).toHaveBeenCalledWith(
      "/training/runs/{run_id}/log",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { run_id: 7 },
          query: { offset: firstPollOffset },
        }),
      }),
    );
    vi.useRealTimers();
  });

  it("does not reset the log when refreshRuns re-resolves to the same active run", async () => {
    // refreshRuns is meant to reset the log tail only when switching to a
    // DIFFERENT run. If it ever fires again for the run already being
    // polled (e.g. a second POST /training/runs succeeding while the
    // first run is still active), resetting unconditionally would append
    // the whole log a second time on top of what's already in state.
    // Drive this via a real refreshRuns call path: submitting the config
    // form again while run 7 is already active and still the one
    // /training/runs resolves to.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let logCallCount = 0;
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
        logCallCount += 1;
        return { data: { text: `chunk ${logCallCount}\n`, offset: logCallCount * 10, status: "running" } };
      }
      if (path === "/training/models") {
        return { data: [] };
      }
      return { data: [] };
    });
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { id: 7, status: "pending" }, error: undefined });

    render(<TrainPage />);

    await vi.waitFor(() => screen.getByText(/running/i));

    // Let one poll tick land so the log has content and a non-zero offset.
    await vi.advanceTimersByTimeAsync(2100);
    expect(await screen.findByText(/chunk 1/)).toBeInTheDocument();

    // Trigger refreshRuns again via the same path a real user action
    // takes (submitting the form), while run 7 is still the active run
    // /training/runs resolves to. The dataset select's own state only
    // initializes from the `datasets` prop on mount (before the async
    // /datasets fetch resolves), so it needs an explicit selection here
    // the same way a real user would pick one, rather than relying on it
    // having pre-selected the only option.
    fireEvent.change(screen.getByLabelText(/dataset/i), { target: { value: "1" } });
    const submitBtn = screen.getByRole("button", { name: /start training/i });
    await act(async () => {
      fireEvent.click(submitBtn);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(vi.mocked(apiClient.POST)).toHaveBeenCalledWith(
      "/training/runs",
      expect.anything(),
    );
    // The already-accumulated log text must still be present -- a reset
    // would have cleared it here even though the run didn't change.
    expect(screen.getByText(/chunk 1/)).toBeInTheDocument();

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
