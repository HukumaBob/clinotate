import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClassificationRunPage } from "./ClassificationRunPage";
import { makeDoc } from "./testDoc";
import type { ClassificationDocument } from "./types";

let runState: Record<string, unknown>;
let predictionsState: { data?: ClassificationDocument; isPending?: boolean; isError?: boolean };
let videoState: Record<string, unknown>;

vi.mock("../../../entities/useInferenceRuns", () => ({
  useInferenceRun: () => ({ data: runState }),
  usePredictions: () => predictionsState,
}));
vi.mock("../../../entities/useVideo", () => ({
  useVideo: () => ({ data: videoState, refetch: vi.fn() }),
}));
vi.mock("../../media/TranscodePrompt", () => ({
  TranscodePrompt: () => <p>Transcode prompt</p>,
}));

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
});
