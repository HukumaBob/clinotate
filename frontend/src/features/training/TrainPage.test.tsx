import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { settingsSchemaFixture } from "./testFixtures";
import { TrainPage } from "./TrainPage";

const datasetRow = (id: number, name: string) => ({
  id,
  name,
  task_type: "detection",
  exported: true,
  item_count: 110,
  split_counts: { train: 80, val: 20, test: 10 },
  balance_metrics: { classes: [{ name: "polyp", instances: 40, frames: 30 }] },
});

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

const { apiClient } = await import("../../shared/api/client");

describe("TrainPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/datasets") {
        return { data: [datasetRow(1, "polyps-v1")] };
      }
      if (path === "/training/runs") {
        return { data: [] };
      }
      if (path === "/training/models") {
        return { data: [] };
      }
      if (path === "/training/settings-schema") {
        return { data: settingsSchemaFixture };
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
        return { data: [datasetRow(1, "polyps-v1")] };
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
      if (path === "/training/settings-schema") return { data: settingsSchemaFixture };
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
        return { data: [datasetRow(1, "polyps-v1")] };
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
      if (path === "/training/settings-schema") return { data: settingsSchemaFixture };
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
        return { data: [datasetRow(1, "polyps-v1")] };
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
      if (path === "/training/base-models") {
        // The start button stays disabled until the catalog offers a model.
        return {
          data: [
            {
              kind: "pretrained",
              weights: "yolo11n.pt",
              label: "yolo11n.pt",
              family: "yolo11",
              size: "n",
              note: null,
              model_version_id: null,
            },
          ],
        };
      }
      if (path === "/training/settings-schema") return { data: settingsSchemaFixture };
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

  it("a run poll does not clobber in-progress edits or reload the settings schema", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = {
      id: 7, status: "running", current_epoch: 1, total_epochs: 10,
      stop_requested: false, error: null, metrics: {},
    };
    vi.mocked(apiClient.GET).mockImplementation((async (path: string) => {
      if (path === "/datasets") return { data: [datasetRow(1, "polyps-v1")] };
      if (path === "/training/runs") return { data: [running] };
      if (path === "/training/runs/{run_id}") return { data: running };
      if (path === "/training/runs/{run_id}/log") {
        return { data: { text: "x\n", offset: 2, status: "running" } };
      }
      if (path === "/training/settings-schema") return { data: settingsSchemaFixture };
      if (path === "/training/models") return { data: [] };
      return { data: [] };
    }) as never);

    render(<TrainPage />);
    await vi.waitFor(() => screen.getByLabelText("Epochs"));
    fireEvent.change(screen.getByLabelText("Epochs"), { target: { value: "25" } });

    await vi.advanceTimersByTimeAsync(2100);

    expect(vi.mocked(apiClient.GET)).toHaveBeenCalledWith(
      "/training/runs/{run_id}/log",
      expect.anything(),
    );
    expect(screen.getByLabelText("Epochs")).toHaveValue(25);
    const schemaCalls = vi
      .mocked(apiClient.GET)
      .mock.calls.filter((call) => (call as unknown[])[0] === "/training/settings-schema");
    expect(schemaCalls).toHaveLength(1);
    vi.useRealTimers();
  });

  it("stops polling once the run reaches a terminal status", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let runStatus = "running";
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/datasets") {
        return { data: [datasetRow(1, "polyps-v1")] };
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
      if (path === "/training/settings-schema") return { data: settingsSchemaFixture };
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

  it("swaps the log for the metrics pane when a model's Info is opened", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/datasets") {
        return { data: [datasetRow(1, "polyps-v1")] };
      }
      if (path === "/training/runs") return { data: [] };
      if (path === "/training/models") {
        return {
          data: [
            {
              id: 7,
              training_run_id: 3,
              name: "yolo11n-run3",
              task_type: "detection",
              metrics: { "metrics/mAP50(B)": 0.65 },
              is_active: false,
              base_model: "yolo11n.pt",
              base_model_version_id: null,
              created_at: "2026-08-21T00:00:00Z",
            },
          ],
        };
      }
      if (path === "/training/models/7/metrics") {
        return {
          data: {
            metrics: { "metrics/mAP50(B)": 0.65 },
            history: [{ epoch: 1, "train/loss": 0.5 }],
            per_class: [],
            confusion: null,
            artifacts: [],
          },
        };
      }
      if (path === "/training/settings-schema") return { data: settingsSchemaFixture };
      return { data: null };
    });

    render(<TrainPage />);

    // No tabs until a model is selected -- the log owns the column.
    expect(await screen.findByRole("button", { name: /^Info$/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Metrics" })).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Info$/ }));
    });

    // Opening Info switches to Metrics, and Log remains one click away.
    const metricsTab = screen.getByRole("tab", { name: "Metrics" });
    expect(metricsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Log" })).toHaveAttribute("aria-selected", "false");
    // The name also appears in the models table below, so assert on the
    // panel's own heading rather than a bare text match.
    expect(screen.getByRole("heading", { name: "yolo11n-run3" })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Log" }));
    });

    expect(screen.getByRole("tab", { name: "Log" })).toHaveAttribute("aria-selected", "true");
  });

  describe("base models", () => {
    const catalog = [
      {
        kind: "pretrained",
        weights: "yolo11n.pt",
        label: "yolo11n.pt",
        family: "yolo11",
        size: "n",
        note: null,
        model_version_id: null,
      },
      {
        kind: "model_version",
        weights: null,
        label: "polyps-v1-run7",
        family: null,
        size: null,
        note: "mAP50 0.650",
        model_version_id: 7,
      },
    ];

    beforeEach(() => {
      vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
        if (path === "/datasets") {
          return { data: [datasetRow(1, "polyps-v1")] };
        }
        if (path === "/training/runs") return { data: [] };
        if (path === "/training/models") {
          return {
            data: [
              {
                id: 7,
                training_run_id: 3,
                name: "polyps-v1-run7",
                task_type: "detection",
                metrics: {},
                is_active: false,
                base_model: "yolo11n.pt",
                base_model_version_id: null,
                created_at: "2026-08-21T00:00:00Z",
              },
            ],
          };
        }
        if (path === "/training/base-models") return { data: catalog };
        if (path === "/training/settings-schema") return { data: settingsSchemaFixture };
        return { data: null };
      });
      vi.mocked(apiClient.POST).mockResolvedValue({ data: { id: 9, status: "pending" }, error: undefined });
    });

    it("loads the catalog for the announced dataset and renders it in the select", async () => {
      render(<TrainPage />);

      expect(
        await screen.findByRole("option", { name: /polyps-v1-run7 — mAP50 0\.650/ }),
      ).toBeInTheDocument();
      expect(vi.mocked(apiClient.GET)).toHaveBeenCalledWith("/training/base-models", {
        params: { query: { dataset_id: 1 } },
      });
    });

    it("posts base_model only for a pretrained choice", async () => {
      render(<TrainPage />);
      await screen.findByRole("option", { name: /polyps-v1-run7 — mAP50/ });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /start training/i })).toBeEnabled(),
      );

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /start training/i }));
      });

      const body = vi.mocked(apiClient.POST).mock.calls[0][1]!.body as Record<string, unknown>;
      expect(body).toEqual({ dataset_id: 1, base_model: "yolo11n.pt", settings: {} });
    });

    it("posts base_model_version_id only for a version choice", async () => {
      render(<TrainPage />);
      await screen.findByRole("option", { name: /polyps-v1-run7 — mAP50/ });

      fireEvent.change(screen.getByLabelText(/base model/i), { target: { value: "version:7" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /start training/i }));
      });

      const body = vi.mocked(apiClient.POST).mock.calls[0][1]!.body as Record<string, unknown>;
      expect(body).toEqual({ dataset_id: 1, base_model_version_id: 7, settings: {} });
    });

    it("requests the settings schema for the announced dataset", async () => {
      render(<TrainPage />);

      await waitFor(() =>
        expect(vi.mocked(apiClient.GET)).toHaveBeenCalledWith("/training/settings-schema", {
          params: { query: { dataset_id: 1 } },
        }),
      );
    });

    it("sends changed settings, name and note", async () => {
      render(<TrainPage />);
      await screen.findByRole("option", { name: /polyps-v1-run7 — mAP50/ });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: /start training/i })).toBeEnabled(),
      );

      fireEvent.change(screen.getByLabelText("Epochs"), { target: { value: "25" } });
      fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: "big frames" } });
      fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "try 800 px" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /start training/i }));
      });

      const body = vi.mocked(apiClient.POST).mock.calls[0][1]!.body;
      expect(body).toEqual({
        dataset_id: 1,
        base_model: "yolo11n.pt",
        name: "big frames",
        note: "try 800 px",
        settings: { epochs: 25 },
      });
    });

    it("keeps the latest dataset's settings schema when responses arrive out of order", async () => {
      const resolvers: Record<number, (v: unknown) => void> = {};
      vi.mocked(apiClient.GET).mockImplementation((async (path: string, opts?: unknown) => {
        if (path === "/datasets") {
          return { data: [datasetRow(1, "polyps-v1"), datasetRow(2, "polyps-v2")] };
        }
        if (path === "/training/runs" || path === "/training/models") return { data: [] };
        if (path === "/training/base-models") return { data: catalog };
        if (path === "/training/settings-schema") {
          const id = (opts as { params: { query: { dataset_id: number } } }).params.query.dataset_id;
          return new Promise((resolve) => {
            resolvers[id] = resolve;
          });
        }
        return { data: null };
      }) as never);
      const schemaWithEpochs = (label: string) => ({
        ...settingsSchemaFixture,
        groups: settingsSchemaFixture.groups.map((group) => ({
          ...group,
          fields: group.fields.map((field) =>
            field.key === "epochs" ? { ...field, label } : field,
          ),
        })),
      });
      render(<TrainPage />);
      await waitFor(() => expect(resolvers[1]).toBeDefined());
      fireEvent.change(screen.getByLabelText(/dataset/i), { target: { value: "2" } });
      await waitFor(() => expect(resolvers[2]).toBeDefined());

      await act(async () => {
        resolvers[2]({ data: schemaWithEpochs("Epochs two") });
      });
      await act(async () => {
        resolvers[1]({ data: schemaWithEpochs("Epochs one") });
      });

      expect(screen.getByLabelText("Epochs two")).toBeInTheDocument();
      expect(screen.queryByLabelText("Epochs one")).not.toBeInTheDocument();
    });

    it("shows an error and keeps Start disabled when the settings schema request fails", async () => {
      vi.mocked(apiClient.GET).mockImplementation((async (path: string) => {
        if (path === "/datasets") return { data: [datasetRow(1, "polyps-v1")] };
        if (path === "/training/base-models") return { data: catalog };
        if (path === "/training/settings-schema") return { data: undefined, error: { detail: "x" } };
        return { data: [] };
      }) as never);
      render(<TrainPage />);

      expect(await screen.findByText("Could not load training settings.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
    });

    it("shows an error when the settings schema request throws", async () => {
      vi.mocked(apiClient.GET).mockImplementation((async (path: string) => {
        if (path === "/datasets") return { data: [datasetRow(1, "polyps-v1")] };
        if (path === "/training/base-models") return { data: catalog };
        if (path === "/training/settings-schema") throw new Error("network down");
        return { data: [] };
      }) as never);
      render(<TrainPage />);

      expect(await screen.findByText("Could not load training settings.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
    });

    it("renders the selected dataset's card from the /datasets row", async () => {
      render(<TrainPage />);

      expect(await screen.findByText(/110 frames/, { selector: "span" })).toBeInTheDocument();
      expect(screen.getByText("polyp")).toBeInTheDocument();
    });

    it("shows the detail of a refused model delete in the alert banner", async () => {
      vi.mocked(apiClient.DELETE).mockResolvedValue({
        data: undefined,
        error: { detail: "Model is the parent of run 12." },
      } as never);
      render(<TrainPage />);

      fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
      });

      expect(await screen.findByRole("alert")).toHaveTextContent("Model is the parent of run 12.");
    });

    it("clears a refused-delete message after a later delete succeeds", async () => {
      vi.mocked(apiClient.DELETE)
        .mockResolvedValueOnce({ data: undefined, error: { detail: "Model is the parent of run 12." } } as never)
        .mockResolvedValueOnce({ data: undefined, error: undefined } as never);
      render(<TrainPage />);

      fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
      });
      expect(await screen.findByRole("alert")).toHaveTextContent("Model is the parent of run 12.");

      fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
      });

      await waitFor(() => expect(screen.queryByText("Model is the parent of run 12.")).toBeNull());
    });

    it("keeps the latest dataset's catalog when responses arrive out of order", async () => {
      const resolvers: Record<number, (v: unknown) => void> = {};
      const two = datasetRow(2, "polyps-v2");
      vi.mocked(apiClient.GET).mockImplementation((async (path: string, opts?: unknown) => {
        if (path === "/datasets") {
          return { data: [datasetRow(1, "polyps-v1"), two] };
        }
        if (path === "/training/runs" || path === "/training/models") return { data: [] };
        if (path === "/training/base-models") {
          const id = (opts as { params: { query: { dataset_id: number } } }).params.query.dataset_id;
          return new Promise((resolve) => {
            resolvers[id] = resolve;
          });
        }
        if (path === "/training/settings-schema") return { data: settingsSchemaFixture };
        return { data: null };
      }) as never);
      const opt = (w: string) => ({
        kind: "pretrained", weights: w, label: w, family: "yolo11", size: "n", note: null,
        model_version_id: null,
      });
      render(<TrainPage />);
      await waitFor(() => expect(resolvers[1]).toBeDefined());
      fireEvent.change(screen.getByLabelText(/dataset/i), { target: { value: "2" } });
      await waitFor(() => expect(resolvers[2]).toBeDefined());

      await act(async () => {
        resolvers[2]({ data: [opt("new.pt")] });
      });
      await act(async () => {
        resolvers[1]({ data: [opt("old.pt")] });
      });

      expect(screen.getByRole("option", { name: "new.pt" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "old.pt" })).not.toBeInTheDocument();
    });

    it("shows an error when the base-models request throws", async () => {
      vi.mocked(apiClient.GET).mockImplementation((async (path: string) => {
        if (path === "/datasets") {
          return { data: [datasetRow(1, "polyps-v1")] };
        }
        if (path === "/training/base-models") throw new Error("network down");
        if (path === "/training/settings-schema") return { data: settingsSchemaFixture };
        return { data: [] };
      }) as never);
      render(<TrainPage />);

      expect(await screen.findByText("Could not load base models.")).toBeInTheDocument();
    });

    it("reloads the catalog when versions are refreshed, keeping a valid selection", async () => {
      const models: unknown[] = [];
      const base = catalog.slice(0, 1);
      let current: unknown[] = base;
      vi.mocked(apiClient.GET).mockImplementation((async (path: string) => {
        if (path === "/datasets") {
          return { data: [datasetRow(1, "polyps-v1")] };
        }
        if (path === "/training/runs") return { data: [] };
        if (path === "/training/models") return { data: models };
        if (path === "/training/base-models") return { data: current };
        if (path === "/training/settings-schema") return { data: settingsSchemaFixture };
        return { data: null };
      }) as never);
      vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined } as never);
      models.push({
        id: 7, training_run_id: 3, name: "polyps-v1-run7", task_type: "detection", metrics: {},
        is_active: false, base_model: "yolo11n.pt", base_model_version_id: null,
        created_at: "2026-08-21T00:00:00Z",
      });
      render(<TrainPage />);
      await screen.findByRole("option", { name: "yolo11n.pt" });
      expect(screen.queryByRole("option", { name: /polyps-v1-run7/ })).not.toBeInTheDocument();

      current = catalog; // backend now offers the new version
      fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
      });

      expect(await screen.findByRole("option", { name: /polyps-v1-run7/ })).toBeInTheDocument();
      expect(screen.getByLabelText(/base model/i)).toHaveValue("pretrained:yolo11n.pt");
    });
  });
});
