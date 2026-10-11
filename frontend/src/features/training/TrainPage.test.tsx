import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deferred } from "./testDeferred";
import { settingsSchemaFixture } from "./testFixtures";
import { TrainPage } from "./TrainPage";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

const { apiClient } = await import("../../shared/api/client");

const datasetRow = (id: number, name: string, exported = true) => ({
  id,
  name,
  task_type: "detection",
  exported,
  item_count: 110,
  split_counts: { train: 80, val: 20, test: 10 },
  balance_metrics: { classes: [{ name: "polyp", instances: 40, frames: 30 }] },
});

const runRow = (over: Record<string, unknown> = {}) => ({
  id: 5, dataset_id: 496, status: "succeeded", task_type: "detection", name: "first try", note: null,
  base_model: "yolo11n.pt", base_model_version_id: null, model_version_id: null,
  config: { imgsz: 640, batch: 4, epochs: 30 }, metrics: { "metrics/mAP50(B)": 0.5 },
  started_at: "2026-10-09T10:00:00Z", finished_at: "2026-10-09T10:01:05Z",
  created_at: "2026-10-09T09:59:00Z", current_epoch: 30, total_epochs: 30, error: null,
  stop_requested: false,
  ...over,
});

const catalog = [
  { kind: "pretrained", weights: "yolo11n.pt", label: "yolo11n.pt", family: "yolo11", size: "n", note: null, model_version_id: null },
  { kind: "pretrained", weights: "yolo11s.pt", label: "yolo11s.pt", family: "yolo11", size: "s", note: null, model_version_id: null },
];

interface World {
  datasets: unknown[];
  runs: Record<number, unknown[]>;
  running: unknown | null;
  runDetail: (id: number) => unknown;
  catalog: unknown[];
  history: unknown[];
}

let world: World;

function installMock() {
  vi.mocked(apiClient.GET).mockImplementation((async (path: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
    switch (path) {
      case "/datasets":
        return { data: world.datasets };
      case "/training/runs": {
        const query = opts?.params?.query ?? {};
        if (query.dataset_id !== undefined) return { data: world.runs[query.dataset_id as number] ?? [] };
        return { data: world.running ? [world.running] : [] };
      }
      case "/training/runs/{run_id}": {
        const id = (opts as unknown as { params: { path: { run_id: number } } }).params.path.run_id;
        return { data: world.runDetail(id) };
      }
      case "/training/runs/{run_id}/metrics":
        return { data: { metrics: {}, history: world.history, per_class: [], confusion: null } };
      case "/training/runs/{run_id}/log":
        return { data: { text: "", offset: 0, status: "running" } };
      case "/training/base-models":
        return { data: world.catalog };
      case "/training/settings-schema":
        return { data: settingsSchemaFixture };
      case "/training/models":
        return { data: [{ id: 3, training_run_id: 5, name: "m3", task_type: "detection", metrics: {}, is_active: false, base_model: "yolo11n.pt", base_model_version_id: null, created_at: "2026-10-09T00:00:00Z" }] };
      case "/training/models/{version_id}/metrics":
        return { data: { metrics: {}, history: [], per_class: [], confusion: null } };
      default:
        return { data: null };
    }
  }) as never);
}

const navLog: Array<{ search: string; type: string }> = [];

function Where() {
  const location = useLocation();
  const type = useNavigationType();
  navLog.push({ search: location.search, type });
  return <div data-testid="where">{location.search}</div>;
}

function renderPage(entry = "/train?dataset=496") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <TrainPage />
      <Where />
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId("where").textContent;
const getCalls = (path: string) =>
  vi.mocked(apiClient.GET).mock.calls.filter((call) => (call as unknown[])[0] === path);

describe("TrainPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navLog.length = 0;
    world = {
      datasets: [datasetRow(496, "polyps-v1"), datasetRow(497, "polyps-v2")],
      runs: { 496: [runRow()], 497: [] },
      running: null,
      runDetail: (id) => runRow({ id }),
      catalog,
      history: [],
    };
    installMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preselects the first exported dataset in the URL when none is given, without adding a history entry", async () => {
    world.datasets = [datasetRow(1, "draft", false), datasetRow(496, "polyps-v1")];
    const late = deferred<{ data: unknown[] }>();
    vi.mocked(apiClient.GET).mockImplementation((async (path: string, opts?: unknown) => {
      if (path === "/datasets") return late.promise;
      return (installMockResult(path, opts));
    }) as never);
    renderPage("/train");
    expect(where()).toBe("");
    await act(async () => {
      late.resolve({ data: world.datasets });
    });
    await waitFor(() => expect(where()).toBe("?dataset=496"));
    // replace, not push: a Back press must not trap the user on the bare URL
    expect(navLog.at(-1)).toEqual({ search: "?dataset=496", type: "REPLACE" });
    expect(navLog.some((entry) => entry.type === "PUSH")).toBe(false);
  });

  it("switching dataset by hand updates the URL and does not re-request the datasets", async () => {
    renderPage();
    await screen.findByText("first try");
    fireEvent.change(screen.getByLabelText("Dataset"), { target: { value: "497" } });
    await waitFor(() => expect(where()).toBe("?dataset=497"));
    expect(getCalls("/datasets")).toHaveLength(1);
  });

  it("shows the datasets in the rail, and this dataset's runs in the Runs tab", async () => {
    renderPage();
    expect(await screen.findByText("first try")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /polyps-v2/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Runs" })).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("tabpanel")).getByRole("table")).toBeInTheDocument();
  });

  it("shows the run count in the dataset card", async () => {
    renderPage();
    expect(await screen.findByText(/1 run\b/)).toBeInTheDocument();
  });

  it("opens a run's details when its row is opened and puts it in the URL; Back returns to the table", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Open run 5" }));
    expect(await screen.findByRole("button", { name: /← Runs/ })).toBeInTheDocument();
    expect(where()).toBe("?dataset=496&run=5");
    fireEvent.click(screen.getByRole("button", { name: /← Runs/ }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(where()).toBe("?dataset=496");
  });

  it("falls back to the table with a message when the run in the URL is not one of this dataset's runs", async () => {
    renderPage("/train?dataset=496&run=99");
    expect(await screen.findByText("first try")).toBeInTheDocument();
    expect(screen.getByText("Run #99 is not on this dataset (it may have been deleted).")).toBeInTheDocument();
  });

  it("selecting a dataset loads its base models and settings schema once", async () => {
    renderPage();
    await screen.findByText("first try");
    await waitFor(() => expect(getCalls("/training/base-models")).toHaveLength(1));
    expect(getCalls("/training/settings-schema")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Dataset"), { target: { value: "497" } });
    await waitFor(() => expect(getCalls("/training/base-models")).toHaveLength(2));
    expect(getCalls("/training/settings-schema")).toHaveLength(2);
    expect(vi.mocked(apiClient.GET)).toHaveBeenCalledWith("/training/base-models", {
      params: { query: { dataset_id: 497 } },
    });
  });

  describe("New run tab", () => {
    beforeEach(() => {
      vi.mocked(apiClient.POST).mockResolvedValue({ data: { id: 9, status: "pending" }, error: undefined } as never);
    });

    async function openNew() {
      renderPage();
      await screen.findByText("first try");
      fireEvent.click(screen.getByRole("tab", { name: "New run" }));
      await waitFor(() => expect(screen.getByRole("button", { name: /start training/i })).toBeEnabled());
    }

    it("switches to the tab, loads the catalog and schema and submits the new body", async () => {
      await openNew();
      expect(where()).toBe("?dataset=496&tab=new");
      fireEvent.change(screen.getByLabelText("Epochs"), { target: { value: "25" } });
      fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: "big frames" } });
      fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "try 800 px" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /start training/i }));
      });
      expect(vi.mocked(apiClient.POST).mock.calls[0][1]!.body).toEqual({
        dataset_id: 496,
        base_model: "yolo11n.pt",
        name: "big frames",
        note: "try 800 px",
        settings: { epochs: 25 },
      });
    });

    it("posts base_model_version_id only for a version choice", async () => {
      world.catalog = [
        ...catalog,
        { kind: "model_version", weights: null, label: "polyps-v1-run7", family: null, size: null, note: "mAP50 0.650", model_version_id: 7 },
      ];
      await openNew();
      fireEvent.change(screen.getByLabelText(/base model/i), { target: { value: "version:7" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /start training/i }));
      });
      expect(vi.mocked(apiClient.POST).mock.calls[0][1]!.body).toEqual({
        dataset_id: 496,
        base_model_version_id: 7,
        settings: {},
      });
    });

    it("after a successful Start it opens the new run, clears name and note and keeps the settings", async () => {
      await openNew();
      fireEvent.change(screen.getByLabelText("Epochs"), { target: { value: "25" } });
      fireEvent.change(screen.getByLabelText(/run name/i), { target: { value: "big frames" } });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /start training/i }));
      });
      await waitFor(() => expect(where()).toBe("?dataset=496&run=9"));
      fireEvent.click(screen.getByRole("tab", { name: "New run" }));
      expect(await screen.findByLabelText(/run name/i)).toHaveValue("");
      expect(screen.getByLabelText("Epochs")).toHaveValue(25);
    });

    it("shows the server's message when starting fails", async () => {
      vi.mocked(apiClient.POST).mockResolvedValue({ data: undefined, error: { detail: "GPU busy" } } as never);
      await openNew();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /start training/i }));
      });
      expect(await screen.findByRole("alert")).toHaveTextContent("GPU busy");
      expect(where()).toBe("?dataset=496&tab=new");
    });

    it("repeat with changes on the selected dataset shows the run's base and settings, starting nothing", async () => {
      world.runs[496] = [runRow({ base_model: "yolo11s.pt", config: { imgsz: 640, batch: 4, epochs: 30 } })];
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Repeat run 5 with changes" }));
      expect(where()).toBe("?dataset=496&tab=new");
      await waitFor(() => expect(screen.getByLabelText("Epochs")).toHaveValue(30));
      expect(screen.getByLabelText(/base model/i)).toHaveValue("pretrained:yolo11s.pt");
      expect(screen.getByLabelText("Batch size")).toHaveValue(4);
      expect(vi.mocked(apiClient.POST)).not.toHaveBeenCalled();
    });

    it("keeps in-progress edits in the form while the active run is polled", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const running = runRow({ id: 7, status: "running", current_epoch: 1, total_epochs: 10 });
      world.running = running;
      world.runDetail = () => running;
      renderPage("/train?dataset=496&tab=new");
      await vi.waitFor(() => screen.getByLabelText("Epochs"));
      fireEvent.change(screen.getByLabelText("Epochs"), { target: { value: "25" } });
      await vi.advanceTimersByTimeAsync(4100);
      expect(getCalls("/training/runs/{run_id}").length).toBeGreaterThan(0);
      expect(screen.getByLabelText("Epochs")).toHaveValue(25);
      expect(getCalls("/training/settings-schema")).toHaveLength(1);
    });
  });

  describe("active run", () => {
    const running = () => runRow({ id: 7, status: "running", name: null, current_epoch: 3, total_epochs: 10 });

    it("shows the strip on every tab with a headline from the metrics, and Stop posts to the stop endpoint", async () => {
      world.running = running();
      world.runDetail = () => running();
      world.history = [{ epoch: 3, "metrics/mAP50(B)": 0.412 }];
      vi.mocked(apiClient.POST).mockResolvedValue({ data: running(), error: undefined } as never);
      renderPage();
      expect(await screen.findByText(/epoch 3 \/ 10/i)).toBeInTheDocument();
      expect(await screen.findByText(/mAP50 0\.412/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("tab", { name: "New run" }));
      expect(screen.getByText(/epoch 3 \/ 10/i)).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      });
      expect(vi.mocked(apiClient.POST)).toHaveBeenCalledWith("/training/runs/{run_id}/stop", {
        params: { path: { run_id: 7 } },
      });
    });

    it("shows a dash as the headline before the first epoch", async () => {
      world.running = running();
      renderPage();
      expect(await screen.findByText(/epoch 3 \/ 10/i)).toBeInTheDocument();
      expect(screen.getByText("—", { selector: "button span" })).toBeInTheDocument();
    });

    it("has no strip when nothing is running", async () => {
      renderPage();
      await screen.findByText("first try");
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });

    it("refreshes the runs table when the active run finishes", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      world.runs[496] = [running()];
      world.running = running();
      world.runDetail = () => runRow({ id: 7, name: "done run" });
      renderPage();
      await vi.waitFor(() => screen.getByText(/epoch 3 \/ 10/i));
      world.runs[496] = [runRow({ id: 7, name: "done run" })];
      world.running = null;
      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => screen.getByText("done run"));
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });
  });

  describe("live details", () => {
    it("updates the open active run's details and its table row from the poll", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const at = (epoch: number, status: string) =>
        runRow({ id: 7, status, name: "live one", current_epoch: epoch, total_epochs: 10 });
      world.runs[496] = [at(0, "pending")];
      world.running = at(0, "pending");
      world.runDetail = () => at(4, "running");
      renderPage("/train?dataset=496&run=7");
      await vi.waitFor(() => screen.getByText("Epoch 0 / 10"));
      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => screen.getByText("Epoch 4 / 10"));
      expect(screen.getAllByText("running").length).toBeGreaterThan(0);
      expect(screen.queryByText("pending")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /← Runs/ }));
      const table = await screen.findByRole("table");
      const row = within(table).getByText("live one").closest("tr")!;
      expect(within(row).getByText("running")).toBeInTheDocument();
    });

    it("opening the active run from the strip resets the view to overview", async () => {
      world.runs[496] = [runRow({ id: 7, status: "running", current_epoch: 3, total_epochs: 10 })];
      world.running = runRow({ id: 7, status: "running", current_epoch: 3, total_epochs: 10 });
      renderPage("/train?dataset=496&run=5&view=log");
      await screen.findByRole("table");
      fireEvent.click(screen.getAllByRole("button", { name: "Open run 7" })[0]);
      await waitFor(() => expect(where()).toBe("?dataset=496&run=7"));
    });
  });

  describe("deleting a run", () => {
    it("deleting the open run clears it from the URL", async () => {
      vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined } as never);
      renderPage("/train?dataset=496&run=5");
      fireEvent.click(await screen.findByRole("button", { name: "Delete run #5" }));
      world.runs[496] = [];
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Confirm delete run #5" }));
      });
      await waitFor(() => expect(where()).toBe("?dataset=496"));
    });

    it("clears a refused-delete message when another dataset is selected or a run is opened", async () => {
      vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: { detail: "Run 5 owns a model." } } as never);
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Delete run 5" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Confirm delete run 5" }));
      });
      expect(await screen.findByRole("alert")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Open run 5" }));
      await waitFor(() => expect(screen.queryByText("Run 5 owns a model.")).not.toBeInTheDocument());
    });

    it("deletes after confirmation and refreshes the table", async () => {
      vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined } as never);
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Delete run 5" }));
      world.runs[496] = [];
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Confirm delete run 5" }));
      });
      expect(vi.mocked(apiClient.DELETE)).toHaveBeenCalledWith("/training/runs/{run_id}", {
        params: { path: { run_id: 5 } },
      });
      expect(await screen.findByText(/No runs on this dataset yet/)).toBeInTheDocument();
    });

    it("shows the server's message on a 409", async () => {
      vi.mocked(apiClient.DELETE).mockResolvedValue({
        data: undefined,
        error: { detail: "Run 5 owns a model." },
      } as never);
      renderPage();
      fireEvent.click(await screen.findByRole("button", { name: "Delete run 5" }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Confirm delete run 5" }));
      });
      expect(await screen.findByRole("alert")).toHaveTextContent("Run 5 owns a model.");
      expect(screen.getByText("first try")).toBeInTheDocument();
    });
  });

  it("a late answer for a previously selected dataset never replaces the current dataset's runs", async () => {
    const slow = deferred<{ data: unknown[] }>();
    vi.mocked(apiClient.GET).mockImplementation((async (path: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
      if (path === "/training/runs" && opts?.params?.query?.dataset_id === 496) return slow.promise;
      return installMockResult(path, opts);
    }) as never);
    world.runs[497] = [runRow({ id: 8, dataset_id: 497, name: "other run" })];
    renderPage();
    await screen.findByLabelText("Dataset");
    fireEvent.change(screen.getByLabelText("Dataset"), { target: { value: "497" } });
    expect(await screen.findByText("other run")).toBeInTheDocument();
    await act(async () => {
      slow.resolve({ data: [runRow({ id: 5, name: "stale run" })] });
    });
    expect(screen.queryByText("stale run")).not.toBeInTheDocument();
    expect(screen.getByText("other run")).toBeInTheDocument();
  });

  describe("run comparison", () => {
    const tick = (id: number) => fireEvent.click(screen.getByRole("checkbox", { name: `Select run ${id} for comparison` }));
    const compareHeading = (text: string) => screen.findByRole("heading", { name: text });

    beforeEach(() => {
      world.runs[496] = [
        runRow({ id: 268, name: "alpha" }),
        runRow({ id: 199, name: "beta" }),
        runRow({ id: 77, name: "gamma" }),
        runRow({ id: 78, name: "delta" }),
        runRow({ id: 90, name: "going", status: "failed" }),
      ];
      world.runs[497] = [runRow({ id: 8, dataset_id: 497, name: "other run" })];
    });

    it("ticking two finished runs and pressing Compare opens the view and writes compare and cmp to the URL", async () => {
      renderPage();
      await screen.findByText("alpha");
      tick(268);
      tick(199);
      expect(where()).toBe("?dataset=496&compare=268%2C199");
      fireEvent.click(screen.getByRole("button", { name: "Compare (2)" }));
      expect(await compareHeading("Comparing #268 alpha, #199 beta")).toBeInTheDocument();
      expect(where()).toBe("?dataset=496&compare=268%2C199&cmp=1");
      expect(screen.queryByRole("table", { name: /runs/i })).not.toBeInTheDocument();
    });

    it("← Runs returns to the table and keeps the ticks", async () => {
      renderPage("/train?dataset=496&compare=268,199&cmp=1");
      fireEvent.click(await screen.findByRole("button", { name: /← Runs/ }));
      expect(await screen.findByText("gamma")).toBeInTheDocument();
      expect(where()).toBe("?dataset=496&compare=268%2C199");
      expect(screen.getByRole("checkbox", { name: "Select run 268 for comparison" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Select run 199 for comparison" })).toBeChecked();
    });

    it("drops ids that are not finished runs of this dataset, shows a note and falls back to the table", async () => {
      renderPage("/train?dataset=496&compare=268,99999&cmp=1");
      expect(await screen.findByText("gamma")).toBeInTheDocument();
      expect(screen.getByText("Some runs in the link are not on this dataset and were left out.")).toBeInTheDocument();
      expect(screen.getByRole("checkbox", { name: "Select run 268 for comparison" })).toBeChecked();
      expect(screen.queryByRole("heading", { name: /^Comparing/ })).not.toBeInTheDocument();
    });

    it("renders the view straight from a deep link", async () => {
      renderPage("/train?dataset=496&compare=268,199&cmp=1");
      expect(await compareHeading("Comparing #268 alpha, #199 beta")).toBeInTheDocument();
      expect(screen.queryByText(/not on this dataset and were left out/)).not.toBeInTheDocument();
      await waitFor(() => expect(getCalls("/training/runs/{run_id}/metrics")).toHaveLength(2));
    });

    it("removing a run below two returns to the table in one URL change, keeping the remaining tick", async () => {
      renderPage("/train?dataset=496&compare=268,199&cmp=1");
      await compareHeading("Comparing #268 alpha, #199 beta");
      fireEvent.click(screen.getByRole("button", { name: "Remove run 268 from the comparison" }));
      expect(await screen.findByText("gamma")).toBeInTheDocument();
      expect(where()).toBe("?dataset=496&compare=199");
      expect(screen.getByRole("checkbox", { name: "Select run 199 for comparison" })).toBeChecked();
    });

    it("removing one of three keeps the view open with the other two", async () => {
      renderPage("/train?dataset=496&compare=268,199,77&cmp=1");
      await compareHeading("Comparing #268 alpha, #199 beta, #77 gamma");
      fireEvent.click(screen.getByRole("button", { name: "Remove run 199 from the comparison" }));
      expect(await compareHeading("Comparing #268 alpha, #77 gamma")).toBeInTheDocument();
      expect(where()).toBe("?dataset=496&compare=268%2C77&cmp=1");
    });

    it("opening a single run from the table clears the compare view", async () => {
      renderPage("/train?dataset=496&compare=268,199");
      await screen.findByText("gamma");
      fireEvent.click(screen.getByRole("button", { name: "Open run 77" }));
      await waitFor(() => expect(where()).toContain("run=77"));
      expect(where()).not.toContain("cmp=1");
      expect(screen.queryByRole("heading", { name: /^Comparing/ })).not.toBeInTheDocument();
    });

    it("switching the dataset clears the selection and the view", async () => {
      renderPage("/train?dataset=496&compare=268,199&cmp=1");
      await compareHeading("Comparing #268 alpha, #199 beta");
      fireEvent.change(screen.getByLabelText("Dataset"), { target: { value: "497" } });
      expect(await screen.findByText("other run")).toBeInTheDocument();
      expect(where()).toBe("?dataset=497");
      expect(screen.queryByRole("heading", { name: /^Comparing/ })).not.toBeInTheDocument();
    });

    it("a late metrics answer for an older selection never shows", async () => {
      const slow = deferred<{ data: unknown }>();
      vi.mocked(apiClient.GET).mockImplementation((async (path: string, opts?: { params?: { path?: { run_id: number } } }) => {
        if (path === "/training/runs/{run_id}/metrics" && opts?.params?.path?.run_id === 268) return slow.promise;
        return installMockResult(path, opts);
      }) as never);
      renderPage("/train?dataset=496&compare=268,199&cmp=1");
      await compareHeading("Comparing #268 alpha, #199 beta");
      expect(screen.getByText("Loading metrics…")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Remove run 268 from the comparison" }));
      await screen.findByText("gamma");
      fireEvent.click(screen.getByRole("checkbox", { name: "Select run 77 for comparison" }));
      fireEvent.click(screen.getByRole("button", { name: "Compare (2)" }));
      await compareHeading("Comparing #199 beta, #77 gamma");
      await screen.findByRole("heading", { name: "Confusion matrices" });
      await act(async () => {
        slow.resolve({ data: { metrics: { staleMetricKey: 1 }, history: [], per_class: [], confusion: null } });
      });
      expect(screen.queryByText("staleMetricKey")).not.toBeInTheDocument();
      expect(screen.queryByText(/#268/)).not.toBeInTheDocument();
    });

    it("allows a third tick but disables a fourth checkbox, and unfinished runs", async () => {
      renderPage();
      await screen.findByText("alpha");
      tick(268);
      tick(199);
      tick(77);
      expect(screen.getByRole("checkbox", { name: "Select run 78 for comparison" })).toBeDisabled();
      expect(screen.getByRole("checkbox", { name: "Select run 90 for comparison" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Compare (3)" })).toBeEnabled();
    });

    it("shows a note for a run whose metrics failed while the other run's data renders", async () => {
      vi.mocked(apiClient.GET).mockImplementation((async (path: string, opts?: { params?: { path?: { run_id: number } } }) => {
        if (path === "/training/runs/{run_id}/metrics") {
          if (opts?.params?.path?.run_id === 199) return { data: undefined, error: { detail: "x" } };
          return { data: { metrics: { mAP50: 0.61 }, history: [], per_class: [], confusion: null } };
        }
        return installMockResult(path, opts);
      }) as never);
      renderPage("/train?dataset=496&compare=268,199&cmp=1");
      expect(await screen.findByText(/Could not load metrics for #199 beta/)).toBeInTheDocument();
      expect(screen.getByText("0.6100")).toBeInTheDocument();
    });
  });

  describe("base models and settings schema", () => {
    it("keeps the latest dataset's catalog when responses arrive out of order", async () => {
      const resolvers: Record<number, (v: unknown) => void> = {};
      vi.mocked(apiClient.GET).mockImplementation((async (path: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
        if (path === "/training/base-models") {
          const id = opts!.params!.query!.dataset_id as number;
          return new Promise((resolve) => {
            resolvers[id] = resolve;
          });
        }
        return installMockResult(path, opts);
      }) as never);
      const opt = (w: string) => ({ kind: "pretrained", weights: w, label: w, family: "yolo11", size: "n", note: null, model_version_id: null });
      renderPage("/train?dataset=496&tab=new");
      await waitFor(() => expect(resolvers[496]).toBeDefined());
      fireEvent.change(screen.getByLabelText("Dataset"), { target: { value: "497" } });
      await waitFor(() => expect(resolvers[497]).toBeDefined());
      await act(async () => {
        resolvers[497]({ data: [opt("new.pt")] });
      });
      await act(async () => {
        resolvers[496]({ data: [opt("old.pt")] });
      });
      expect(screen.getByRole("option", { name: "new.pt" })).toBeInTheDocument();
      expect(screen.queryByRole("option", { name: "old.pt" })).not.toBeInTheDocument();
    });

    it("keeps the latest dataset's settings schema when responses arrive out of order", async () => {
      const resolvers: Record<number, (v: unknown) => void> = {};
      vi.mocked(apiClient.GET).mockImplementation((async (path: string, opts?: { params?: { query?: Record<string, unknown> } }) => {
        if (path === "/training/settings-schema") {
          const id = opts!.params!.query!.dataset_id as number;
          return new Promise((resolve) => {
            resolvers[id] = resolve;
          });
        }
        return installMockResult(path, opts);
      }) as never);
      const withLabel = (label: string) => ({
        ...settingsSchemaFixture,
        groups: settingsSchemaFixture.groups.map((group) => ({
          ...group,
          fields: group.fields.map((f) => (f.key === "epochs" ? { ...f, label } : f)),
        })),
      });
      renderPage("/train?dataset=496&tab=new");
      await waitFor(() => expect(resolvers[496]).toBeDefined());
      fireEvent.change(screen.getByLabelText("Dataset"), { target: { value: "497" } });
      await waitFor(() => expect(resolvers[497]).toBeDefined());
      await act(async () => {
        resolvers[497]({ data: withLabel("Epochs two") });
      });
      await act(async () => {
        resolvers[496]({ data: withLabel("Epochs one") });
      });
      expect(screen.getByLabelText("Epochs two")).toBeInTheDocument();
      expect(screen.queryByLabelText("Epochs one")).not.toBeInTheDocument();
    });

    it("shows an error and keeps Start disabled when the settings schema request fails or throws", async () => {
      vi.mocked(apiClient.GET).mockImplementation((async (path: string, opts?: unknown) => {
        if (path === "/training/settings-schema") return { data: undefined, error: { detail: "x" } };
        return installMockResult(path, opts);
      }) as never);
      renderPage("/train?dataset=496&tab=new");
      expect(await screen.findByText("Could not load training settings.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /start training/i })).toBeDisabled();
    });

    it("shows an error when the base-models request throws", async () => {
      vi.mocked(apiClient.GET).mockImplementation((async (path: string, opts?: unknown) => {
        if (path === "/training/base-models") throw new Error("network down");
        return installMockResult(path, opts);
      }) as never);
      renderPage("/train?dataset=496&tab=new");
      expect(await screen.findByText("Could not load base models.")).toBeInTheDocument();
    });

    it("reloads the catalog when the run details report a change", async () => {
      world.runs[496] = [runRow({ id: 5, model_version_id: 3 })];
      world.runDetail = () => runRow({ id: 5, model_version_id: 3 });
      vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined } as never);
      renderPage("/train?dataset=496&run=5&view=model");
      await waitFor(() => expect(getCalls("/training/base-models")).toHaveLength(1));
      const del = await screen.findByRole("button", { name: "Delete model m3" });
      fireEvent.click(del);
      await act(async () => {
        fireEvent.click(await screen.findByRole("button", { name: "Confirm delete model m3" }));
      });
      await waitFor(() => expect(getCalls("/training/base-models").length).toBeGreaterThan(1));
    });

    it("reloads the catalog when the active run finishes, keeping a valid selection", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      world.running = runRow({ id: 7, status: "running", current_epoch: 1, total_epochs: 10 });
      world.runDetail = () => runRow({ id: 7 });
      renderPage("/train?dataset=496&tab=new");
      await vi.waitFor(() => screen.getByRole("option", { name: "yolo11s.pt" }));
      fireEvent.change(screen.getByLabelText(/base model/i), { target: { value: "pretrained:yolo11s.pt" } });
      world.catalog = [
        ...catalog,
        { kind: "model_version", weights: null, label: "fresh-model", family: null, size: null, note: null, model_version_id: 11 },
      ];
      world.running = null;
      await vi.advanceTimersByTimeAsync(2100);
      await vi.waitFor(() => screen.getByRole("option", { name: "fresh-model" }));
      expect(screen.getByLabelText(/base model/i)).toHaveValue("pretrained:yolo11s.pt");
    });
  });
});

// Default answers for the branches a test does not override.
function installMockResult(path: string, opts?: unknown) {
  switch (path) {
    case "/datasets":
      return { data: world.datasets };
    case "/training/runs": {
      const query = (opts as { params?: { query?: Record<string, unknown> } })?.params?.query ?? {};
      if (query.dataset_id !== undefined) return { data: world.runs[query.dataset_id as number] ?? [] };
      return { data: world.running ? [world.running] : [] };
    }
    case "/training/base-models":
      return { data: world.catalog };
    case "/training/settings-schema":
      return { data: settingsSchemaFixture };
    case "/training/runs/{run_id}":
      return { data: world.runDetail((opts as { params: { path: { run_id: number } } }).params.path.run_id) };
    case "/training/runs/{run_id}/metrics":
      return { data: { metrics: {}, history: [], per_class: [], confusion: null } };
    case "/training/models":
      return { data: [{ id: 3, training_run_id: 5, name: "m3", task_type: "detection", metrics: {}, is_active: false, base_model: "yolo11n.pt", base_model_version_id: null, created_at: "2026-10-09T00:00:00Z" }] };
    case "/training/models/{version_id}/metrics":
      return { data: { metrics: {}, history: [], per_class: [], confusion: null } };
    default:
      return { data: null };
  }
}
