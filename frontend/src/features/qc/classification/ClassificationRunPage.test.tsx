import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EvaluationRead } from "../../../entities/useEvaluation";
import { ClassificationRunPage } from "./ClassificationRunPage";
import { makeDoc } from "./testDoc";
import type { ClassificationDocument } from "./types";

let runState: Record<string, unknown>;
let predictionsState: { data?: ClassificationDocument; isPending?: boolean; isError?: boolean };
let videoState: Record<string, unknown>;
let referenceState: { data?: Record<string, unknown>; isPending?: boolean; isError?: boolean };
const createInterval = vi.fn();
const deleteInterval = vi.fn();
let restoreState: { isError?: boolean; error?: unknown };
let evalState: { data?: EvaluationRead; isPending?: boolean; isError?: boolean; error?: unknown };
const useEvaluation = vi.fn();

vi.mock("../../../entities/useInferenceRuns", () => ({
  useInferenceRun: () => ({ data: runState }),
  usePredictions: () => predictionsState,
}));
vi.mock("../../../entities/useVideo", () => ({
  useVideo: () => ({ data: videoState, refetch: vi.fn() }),
}));
vi.mock("../../../entities/useReference", () => ({
  useReference: () => referenceState,
  useCreateInterval: () => ({ mutateAsync: createInterval }),
  useUpdateInterval: () => ({ mutateAsync: vi.fn() }),
  useDeleteInterval: () => ({ mutateAsync: vi.fn(), mutate: deleteInterval }),
  useRestoreClean: () => ({ mutate: vi.fn(), ...restoreState }),
}));
vi.mock("../../../entities/useEvaluation", () => ({
  useEvaluation: (...args: unknown[]) => {
    useEvaluation(...args);
    return evalState;
  },
}));
vi.mock("../../media/TranscodePrompt", () => ({
  TranscodePrompt: () => <p>Transcode prompt</p>,
}));

/** Location shares its class names with the model's Anatomy axis; Quality
 * matches no model axis. */
function makeReference(status: "none" | "clean" | "compromised", withAxes = true) {
  return {
    video_id: 9, procedure_id: 1, duration_ms: 1000, status,
    compromised_at: status === "compromised" ? "2026-11-01T10:00:00Z" : null,
    compromised_by_training_run_id: status === "compromised" ? 4 : null,
    axes: withAxes
      ? [
          {
            category_id: 2, name: "Location",
            classes: [
              { label_id: 10, name: "caecum", key: "1" },
              { label_id: 11, name: "ascending", key: "2" },
              { label_id: 12, name: "transverse", key: "3" },
            ],
          },
          { category_id: 3, name: "Quality", classes: [{ label_id: 20, name: "Good", key: "4" }] },
        ]
      : [],
    intervals: [],
  };
}

type EvalAxis = EvaluationRead["axes"][number];

function evalAxis(name: string, over: Partial<EvalAxis> = {}): EvalAxis {
  return {
    name, matched: true, reference_category_id: 2, reference_axis_name: "Location",
    frames_total: 7, frames_evaluated: 7, frames_excluded: 0, accuracy: 0.857, macro_f1: 0.8,
    classes: [], confusion: { labels: [], matrix: [] },
    errors: { boundary_frames: 0, interior_frames: 1 },
    transitions: { reference: 1, model_switches: 3, excess_switches: 2, median_lag_ms: null, never_switched: 0, lags: [] },
    episodes: [
      { start_ms: 200, end_ms: 200, frames: 1, truth: "caecum", predicted: "ascending",
        kind: "interior", mean_confidence: 0.8, max_confidence: 0.8 },
    ],
    ...over,
  };
}

/** A reference with one labeled (non-orphaned) interval on Location, from 0.6 s. */
function labeledReference() {
  const reference = makeReference("clean");
  reference.intervals = [
    { id: 50, video_id: 9, category_id: 2, label_id: 10, taxonomy_version: 1, start_ms: 600, end_ms: 1000, orphaned: false },
  ] as never[];
  return reference;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/qc/5"]}>
      <Routes>
        <Route path="/qc/:runId" element={<ClassificationRunPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  runState = {
    id: 5, video_id: 9, model_name: "Anatomy, Mode", frame_stride: 1, status: "succeeded",
    frames_processed: 7, frames_total: 7, error: null, task_type: "classification",
    axes: [{ name: "Anatomy" }, { name: "Mode" }],
  };
  predictionsState = { data: makeDoc(), isPending: false };
  createInterval.mockReset();
  deleteInterval.mockReset();
  restoreState = {};
  createInterval.mockImplementation(async (vars: { labelId: number; startMs: number; endMs: number }) => ({
    id: 100, video_id: 9, category_id: 2, label_id: vars.labelId, taxonomy_version: 1,
    start_ms: vars.startMs, end_ms: vars.endMs, orphaned: false,
  }));
  referenceState = { data: makeReference("clean") };
  useEvaluation.mockClear();
  evalState = {
    data: {
      run_id: 5, video_id: 9, reference_status: "clean", boundary_ms: 2000,
      axes: [evalAxis("Anatomy"), evalAxis("Mode", { matched: false, reference_category_id: null, reference_axis_name: null })],
    },
  };
  videoState = { id: 9, title: "Colonoscopy 1", stream_url: "/v.mp4", duration_seconds: 1, browser_playable: true };
});

describe("ClassificationRunPage", () => {
  it("shows lanes and badges without the detection panels", async () => {
    renderPage();
    expect(screen.getByRole("group", { name: "Anatomy" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Mode" })).toBeInTheDocument();
    expect(await screen.findByText("caecum 91%")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Flags" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Review reels" })).toBeNull();
    expect(screen.queryByLabelText("Confidence")).toBeNull();
    expect(screen.queryByLabelText("NMS IoU")).toBeNull();
    expect(screen.getByLabelText("Blip window")).toBeInTheDocument();
  });

  it("steps through the blips of all axes merged by time", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    const video = container.querySelector("video")!;
    expect(screen.getByText("2 blips")).toBeInTheDocument();

    await user.keyboard("]");
    expect(video.currentTime).toBeCloseTo(0.2);
    expect(screen.getByRole("group", { name: "Anatomy" })).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("group", { name: "Mode" })).toHaveAttribute("data-active", "false");

    await user.keyboard("]");
    expect(video.currentTime).toBeCloseTo(0.4);
    expect(screen.getByRole("group", { name: "Mode" })).toHaveAttribute("data-active", "true");

    await user.keyboard("[[");
    expect(video.currentTime).toBeCloseTo(0.2);

    await user.click(screen.getByRole("button", { name: /Next event/ }));
    expect(video.currentTime).toBeCloseTo(0.4);
  });

  it("says blips, not flicker events, when there are none", () => {
    const doc = makeDoc();
    for (const frame of Object.values(doc.frames)) {
      frame.axes = frame.axes.map((axis) => ({ ...axis, class_id: 0 }));
    }
    predictionsState = { data: doc, isPending: false };
    renderPage();
    expect(screen.getByText("No blips at these settings")).toBeInTheDocument();
    expect(screen.queryByText(/flicker/i)).toBeNull();
  });

  it("clears the highlight when the user seeks elsewhere after a jump", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    await user.keyboard("]");
    expect(screen.getByRole("group", { name: "Anatomy" })).toHaveAttribute("data-active", "true");
    const [track] = screen.getAllByTestId("lane-track");
    track.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, height: 10, right: 100, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    await user.click(track);
    expect(screen.getByRole("group", { name: "Anatomy" })).toHaveAttribute("data-active", "false");
    expect(container.querySelector("video")).not.toBeNull();
  });

  it("clears the highlight when playback leaves the blip but keeps it inside", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    const video = container.querySelector("video")!;
    await user.keyboard("]");
    video.dispatchEvent(new Event("timeupdate"));
    expect(screen.getByRole("group", { name: "Anatomy" })).toHaveAttribute("data-active", "true");
    video.currentTime = 0.5;
    video.dispatchEvent(new Event("timeupdate"));
    await vi.waitFor(() =>
      expect(screen.getByRole("group", { name: "Anatomy" })).toHaveAttribute("data-active", "false"),
    );
  });

  it("warns when the stride makes the blip window span seconds", () => {
    predictionsState = { data: makeDoc(800, 20), isPending: false };
    renderPage();
    expect(screen.getByRole("note")).toHaveTextContent(/too coarse/);
  });

  it("does not warn at a fine stride", () => {
    renderPage();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("offers a transcode for a video the browser cannot play", () => {
    videoState = { ...videoState, browser_playable: false };
    const { container } = renderPage();
    expect(screen.getByText("Transcode prompt")).toBeInTheDocument();
    expect(container.querySelector("video")).toBeNull();
  });

  it("shows a failed run's error", () => {
    runState = { ...runState, status: "failed", error: "CUDA out of memory" };
    predictionsState = {};
    renderPage();
    expect(screen.getByText("CUDA out of memory")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Anatomy" })).toBeNull();
  });

  it("shows when predictions could not be loaded", () => {
    predictionsState = { isPending: false, isError: true };
    renderPage();
    expect(screen.getByText("Could not load predictions.")).toBeInTheDocument();
  });

  it("puts the reference lane above the matching model lane and none on unmatched axes", () => {
    renderPage();
    const anatomy = screen.getByRole("group", { name: "Anatomy" });
    const refLane = within(anatomy).getByTestId("lane-2");
    const modelTrack = within(anatomy).getByTestId("lane-track");
    expect(refLane.compareDocumentPosition(modelTrack) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Mode" })).queryByTestId(/^lane-\d/)).toBeNull();
    expect(screen.queryByTestId("lane-3")).toBeNull();
    // The legend shows the matched axis' keys only.
    expect(screen.getByRole("button", { name: /caecum/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Good/ })).toBeNull();
  });

  it("edits the reference with a digit key", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.keyboard("1");
    await vi.waitFor(() =>
      expect(createInterval).toHaveBeenCalledWith(expect.objectContaining({ labelId: 10, startMs: 0 })),
    );
  });

  it("does not edit the reference with a key of an unmatched axis", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.keyboard("4");
    expect(createInterval).not.toHaveBeenCalled();
  });

  it("still steps blips with ] when a reference is shown", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    await user.keyboard("]");
    expect(container.querySelector("video")!.currentTime).toBeCloseTo(0.2);
    expect(createInterval).not.toHaveBeenCalled();
  });

  it("warns when the reference is compromised and not when it is clean", () => {
    const banner = "This video's reference is no longer an unbiased test: frames of it were used for training";
    renderPage();
    expect(screen.queryByText(banner)).toBeNull();
    referenceState = { data: makeReference("compromised") };
    renderPage();
    expect(screen.getByText(banner)).toBeInTheDocument();
  });

  it("offers to label a video with no reference axes and shows the model lanes alone", () => {
    referenceState = { data: makeReference("none", false) };
    renderPage();
    expect(screen.getByRole("group", { name: "Anatomy" })).toBeInTheDocument();
    expect(screen.queryByTestId("lane-2")).toBeNull();
    expect(screen.getByRole("link", { name: "Label reference" })).toHaveAttribute("href", "/qc/reference/9");
  });

  it("offers to label when the video has no reference yet", () => {
    referenceState = { data: makeReference("none") };
    renderPage();
    expect(screen.getByRole("link", { name: "Label reference" })).toHaveAttribute("href", "/qc/reference/9");
  });

  it("does not offer the link for a labeled, matched reference", () => {
    renderPage();
    expect(screen.queryByRole("link", { name: "Label reference" })).toBeNull();
  });

  it("shows only the model lanes while the reference loads or when it fails", () => {
    referenceState = { isPending: true };
    const first = renderPage();
    expect(screen.getByRole("group", { name: "Anatomy" })).toBeInTheDocument();
    expect(screen.queryByTestId("lane-2")).toBeNull();
    first.unmount();
    referenceState = { isPending: false, isError: true };
    renderPage();
    expect(screen.getByRole("group", { name: "Anatomy" })).toBeInTheDocument();
    expect(screen.queryByTestId("lane-2")).toBeNull();
    expect(screen.queryByText(/unbiased test/)).toBeNull();
  });
  it("says a failed reference save was undone", async () => {
    createInterval.mockRejectedValue({ detail: "overlap" });
    const user = userEvent.setup();
    renderPage();
    await user.keyboard("1");
    expect(await screen.findByRole("alert")).toHaveTextContent("Not saved: the change was undone.");
  });

  it("lists orphaned reference intervals of the matched axes and deletes one", () => {
    const reference = makeReference("clean");
    reference.intervals = [
      { id: 31, video_id: 9, category_id: 2, label_id: 77, taxonomy_version: 1, start_ms: 0, end_ms: 500, orphaned: true },
      { id: 32, video_id: 9, category_id: 3, label_id: 78, taxonomy_version: 1, start_ms: 0, end_ms: 500, orphaned: true },
    ] as never[];
    referenceState = { data: reference };
    renderPage();
    expect(screen.getByText(/1 orphaned interval/)).toBeInTheDocument();
    expect(screen.getByText(/Label #77 0:00–0:00/)).toBeInTheDocument();
    expect(screen.queryByText(/Label #78/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteInterval).toHaveBeenCalledWith(31);
  });

  it("draws the reference lane on the same duration the editor uses", () => {
    const reference = makeReference("clean");
    reference.duration_ms = 2000;
    reference.intervals = [
      { id: 40, video_id: 9, category_id: 2, label_id: 10, taxonomy_version: 1, start_ms: 1000, end_ms: 2000, orphaned: false },
    ] as never[];
    referenceState = { data: reference };
    renderPage();
    const segment = screen.getByTestId("segment-40");
    expect(segment.style.left).toBe("50%");
    expect(segment.style.width).toBe("50%");
  });

  it("shows why restoring the reference to clean failed", () => {
    referenceState = { data: makeReference("compromised") };
    restoreState = { isError: true, error: { detail: "Video 9 has no reference" } };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Video 9 has no reference");
  });

  it("shows the evaluation panel under the blip window", () => {
    referenceState = { data: labeledReference() };
    renderPage();
    const panel = screen.getByRole("region", { name: "Evaluation" });
    const blipWindow = screen.getByLabelText("Blip window");
    expect(blipWindow.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(useEvaluation).toHaveBeenCalledWith(5, 2000, true);
    expect(useEvaluation.mock.calls.every((call) => call[1] === 2000)).toBe(true);
  });

  it("hatches the error episodes on the matched model lane only", () => {
    referenceState = { data: labeledReference() };
    renderPage();
    const anatomy = screen.getByRole("group", { name: "Anatomy" });
    const span = within(within(anatomy).getByTestId("lane-track")).getByTestId("error-span-0-0");
    // 200 ms plus one 100 ms processed step, on a 1000 ms lane.
    expect(span.style.left).toBe("20%");
    expect(span.style.width).toBe("10%");
    expect(within(screen.getByRole("group", { name: "Mode" })).queryByTestId(/^error-span-/)).toBeNull();
  });

  it("follows the panel's boundary tolerance", () => {
    referenceState = { data: labeledReference() };
    renderPage();
    fireEvent.change(screen.getByLabelText("Boundary tolerance (s)"), { target: { value: "0.5" } });
    fireEvent.blur(screen.getByLabelText("Boundary tolerance (s)"));
    expect(useEvaluation).toHaveBeenLastCalledWith(5, 500, true);
    const last = useEvaluation.mock.calls.slice(-2);
    expect(last.every((call) => call[1] === 500)).toBe(true);
  });

  it("pauses and seeks when an episode is clicked, dropping the blip highlight", async () => {
    referenceState = { data: labeledReference() };
    const user = userEvent.setup();
    const { container } = renderPage();
    const video = container.querySelector("video")!;
    const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
    await user.keyboard("]]");
    expect(screen.getByRole("group", { name: "Mode" })).toHaveAttribute("data-active", "true");
    await user.click(screen.getByRole("button", { name: /caecum → ascending/ }));
    expect(pause).toHaveBeenCalled();
    expect(video.currentTime).toBeCloseTo(0.2);
    expect(screen.getByRole("group", { name: "Mode" })).toHaveAttribute("data-active", "false");
    expect(screen.getByRole("group", { name: "Anatomy" })).toHaveAttribute("data-active", "false");
  });

  it("requests nothing and draws no hatching without reference labels", () => {
    renderPage();
    expect(screen.getByText("Label this video's reference to score the model")).toBeInTheDocument();
    expect(useEvaluation.mock.calls.length).toBeGreaterThan(0);
    expect(useEvaluation.mock.calls.every((call) => call[2] === false)).toBe(true);
    expect(screen.queryByTestId(/^error-span-/)).toBeNull();
  });

  it("neither requests nor claims there is no reference while the reference loads", () => {
    referenceState = { isPending: true };
    renderPage();
    expect(screen.queryByText("Label this video's reference to score the model")).toBeNull();
    expect(within(screen.getByRole("region", { name: "Evaluation" })).getByText("Loading…")).toBeInTheDocument();
    expect(useEvaluation.mock.calls.every((call) => call[2] === false)).toBe(true);
  });

  it("says the reference could not be loaded when it fails, requesting nothing", () => {
    referenceState = { isPending: false, isError: true };
    renderPage();
    expect(screen.getByText("The reference could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("Label this video's reference to score the model")).toBeNull();
    expect(useEvaluation.mock.calls.every((call) => call[2] === false)).toBe(true);
  });

  it("does not count orphaned intervals as reference labels", () => {
    const reference = labeledReference();
    (reference.intervals as unknown as { orphaned: boolean }[])[0].orphaned = true;
    referenceState = { data: reference };
    renderPage();
    expect(screen.getByText("Label this video's reference to score the model")).toBeInTheDocument();
    expect(useEvaluation.mock.calls.every((call) => call[2] === false)).toBe(true);
  });

  it("works while the evaluation loads or fails", async () => {
    referenceState = { data: labeledReference() };
    evalState = { isPending: true };
    const first = renderPage();
    expect(screen.getByText("Scoring…")).toBeInTheDocument();
    expect(screen.queryByTestId(/^error-span-/)).toBeNull();
    first.unmount();
    evalState = { isError: true, error: { detail: "Run not found" } };
    const user = userEvent.setup();
    const { container } = renderPage();
    expect(screen.getByText("Run not found")).toBeInTheDocument();
    expect(screen.queryByTestId(/^error-span-/)).toBeNull();
    await user.keyboard("]");
    expect(container.querySelector("video")!.currentTime).toBeCloseTo(0.2);
    await user.keyboard("2");
    await vi.waitFor(() =>
      expect(createInterval).toHaveBeenCalledWith(expect.objectContaining({ labelId: 11, startMs: 200 })),
    );
  });

  it("shows no evaluation panel before the run has succeeded", () => {
    referenceState = { data: labeledReference() };
    runState = { ...runState, status: "running" };
    predictionsState = {};
    renderPage();
    expect(screen.queryByRole("region", { name: "Evaluation" })).toBeNull();
  });
});

describe("ClassificationRunPage working area", () => {
  it("outlines the run's working area over the full video", () => {
    runState = { ...runState, crop_box: { left: 10, right: 10, top: 5, bottom: 5 } };
    renderPage();
    expect(screen.getByTestId("crop-overlay-border")).toBeInTheDocument();
  });

  it.each([null, undefined])("draws no outline when crop_box is %s", (crop_box) => {
    runState = { ...runState, crop_box };
    renderPage();
    expect(screen.queryByTestId("crop-overlay-root")).toBeNull();
  });
});
