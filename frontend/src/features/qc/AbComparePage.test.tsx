import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AbComparePage } from "./AbComparePage";

const mutateByRun: Record<number, ReturnType<typeof vi.fn>> = { 1: vi.fn(), 2: vi.fn() };
let compareState: { data?: unknown; error?: unknown; isPending?: boolean };

const run = (id: number) => ({
  id, video_id: 9, model_name: `model-${id}`, frame_stride: 1, status: "succeeded",
  perturbation: id === 2 ? { kind: "blur", strength: 2 } : null,
});
const doc = { task_type: "detection", model: { name: "m", version_id: 1 }, fps: 25, frame_stride: 1, classes: ["polyp"], frames: {} };

vi.mock("../../entities/useInferenceRuns", () => ({
  useInferenceRun: (id: number) => ({ data: run(id) }),
  usePredictions: () => ({ data: doc, isPending: false }),
}));
vi.mock("../../entities/useVideo", () => ({
  useVideo: () => ({ data: { id: 9, stream_url: "/v.mp4", duration_seconds: 10, browser_playable: true } }),
}));
vi.mock("../../entities/useQcCompare", () => ({ useQcCompare: () => compareState }));
vi.mock("../../entities/useQcFlags", () => ({
  useQcFlags: () => ({ data: [] }),
  usePutQcFlag: (runId: number) => ({ mutate: mutateByRun[runId], isPending: false }),
}));
vi.mock("./PredictionOverlay", () => ({ PredictionOverlay: () => null }));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/qc/compare/1/2"]}>
      <Routes>
        <Route path="/qc/compare/:runA/:runB" element={<AbComparePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mutateByRun[1] = vi.fn();
  mutateByRun[2] = vi.fn();
  compareState = {
    data: {
      total: 50,
      disagreements: 2,
      frames: [
        { frame: 10, timestamp_ms: 400, only_a: ["polyp"], only_b: [] },
        { frame: 20, timestamp_ms: 800, only_a: [], only_b: ["polyp"] },
      ],
    },
  };
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

describe("AbComparePage", () => {
  it("summarises the disagreements and badges the stress run", () => {
    renderPage();
    expect(screen.getByText("2 disagreements out of 50 frames")).toBeInTheDocument();
    expect(screen.getByText("Stress: blur 2")).toBeInTheDocument();
  });

  it("jumps to the first disagreement and flags the wrong side", async () => {
    const user = userEvent.setup();
    const { container } = renderPage();
    await user.click(screen.getByRole("button", { name: "Next disagreement" }));
    const [videoA] = container.querySelectorAll("video");
    expect(videoA.currentTime).toBeCloseTo(0.4);

    await user.click(await screen.findByRole("button", { name: "A wrong" }));
    expect(mutateByRun[1]).toHaveBeenCalledWith({ frame_index: 10, timestamp_ms: 400, kind: "fp" });
    await user.click(screen.getByRole("button", { name: "B wrong" }));
    expect(mutateByRun[2]).toHaveBeenCalledWith({ frame_index: 10, timestamp_ms: 400, kind: "fn" });
  });

  it("shows a compare error instead of the videos", () => {
    compareState = { error: { detail: "The runs are of different videos" } };
    const { container } = renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("The runs are of different videos");
    expect(container.querySelector("video")).toBeNull();
  });
});
