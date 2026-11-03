import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EvaluationRead } from "../../../entities/useEvaluation";
import { EvaluationPanel } from "./EvaluationPanel";

let evalState: { data?: EvaluationRead; isPending?: boolean; isError?: boolean; error?: unknown };
const useEvaluation = vi.fn();

vi.mock("../../../entities/useEvaluation", () => ({
  useEvaluation: (...args: unknown[]) => {
    useEvaluation(...args);
    return evalState;
  },
}));

type Axis = EvaluationRead["axes"][number];
type Ep = Axis["episodes"][number];

const ep = (start_ms: number, frames: number, conf: number, kind: Ep["kind"] = "interior"): Ep => ({
  start_ms, end_ms: start_ms + 500, frames, truth: "Polyp", predicted: "Fold",
  kind, mean_confidence: conf, max_confidence: conf,
});

function makeAxis(over: Partial<Axis> = {}): Axis {
  return {
    name: "Finding", matched: true, reference_category_id: 1, reference_axis_name: "Finding",
    frames_total: 12, frames_evaluated: 8, frames_excluded: 4, accuracy: 0.625, macro_f1: 0.5,
    classes: [
      { name: "Polyp", support: 5, tp: 3, fp: 1, fn: 2, precision: 0.75, recall: 0.6, f1: 0.667 },
      { name: "Fold", support: 3, tp: 2, fp: 2, fn: 1, precision: null, recall: 0.667, f1: null },
    ],
    confusion: { labels: ["Polyp", "Fold"], matrix: [[3, 2], [1, 2]] },
    errors: { boundary_frames: 1, interior_frames: 2 },
    transitions: {
      reference: 1, model_switches: 4, excess_switches: 3, median_lag_ms: 1000,
      never_switched: 2, lags: [],
    },
    episodes: [ep(65000, 1, 0.5, "boundary"), ep(1000, 3, 0.4), ep(5000, 2, 0.9)],
    ...over,
  };
}

function makeEval(axes: Axis[] = [makeAxis()], status: EvaluationRead["reference_status"] = "clean"): EvaluationRead {
  return { run_id: 7, video_id: 9, reference_status: status, boundary_ms: 0, axes };
}

function renderPanel(props: Partial<Parameters<typeof EvaluationPanel>[0]> = {}) {
  const onSeek = vi.fn();
  render(
    <MemoryRouter>
      <EvaluationPanel runId={7} videoId={9} hasReference onSeek={onSeek} {...props} />
    </MemoryRouter>,
  );
  return onSeek;
}

beforeEach(() => {
  useEvaluation.mockClear();
  evalState = { data: makeEval() };
});

describe("EvaluationPanel", () => {
  it("renders the summary", () => {
    renderPanel();
    expect(screen.getByText("62.5%")).toBeInTheDocument();
    expect(screen.getByText("50.0%")).toBeInTheDocument();
    expect(screen.getByText(/8 evaluated/)).toBeInTheDocument();
    expect(screen.getByText(/4 excluded/)).toBeInTheDocument();
    expect(screen.getByText(/1 at boundaries, 2 inside/)).toBeInTheDocument();
    expect(screen.getByText(/4 model switches vs 1 in the reference \(3 excess\)/)).toBeInTheDocument();
    expect(screen.getByText(/Median lag 1\.0 s/)).toBeInTheDocument();
    expect(screen.getByText(/2 never switched/)).toBeInTheDocument();
  });

  it("renders the class table with dashes for null", () => {
    renderPanel();
    const row = screen.getByRole("row", { name: /^Fold 3/ });
    expect(within(row).getAllByText("—")).toHaveLength(2);
    expect(within(screen.getByRole("row", { name: /Polyp 5/ })).getByText("75.0%")).toBeInTheDocument();
  });

  it("renders the confusion matrix", () => {
    renderPanel();
    const table = screen.getByRole("table", { name: "Confusion matrix" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("Fold")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Polyp")).toBeInTheDocument();
    expect(within(rows[1]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["3", "2"]);
    expect(within(rows[2]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["1", "2"]);
  });

  it("sorts episodes with both buttons and seeks on click", async () => {
    const onSeek = renderPanel();
    const starts = () =>
      screen.getAllByRole("button", { name: /Polyp → Fold/ }).map((b) => b.textContent);
    expect(screen.getByRole("button", { name: "Longest first" })).toHaveAttribute("aria-pressed", "true");
    expect(starts()[0]).toMatch(/^0:01/);
    await userEvent.click(screen.getByRole("button", { name: "Most confident first" }));
    expect(screen.getByRole("button", { name: "Most confident first" })).toHaveAttribute("aria-pressed", "true");
    expect(starts()[0]).toMatch(/^0:05.*90%/);
    await userEvent.click(screen.getAllByRole("button", { name: /Polyp → Fold/ })[0]);
    expect(onSeek).toHaveBeenCalledWith(5000);
    expect(starts()[1]).toMatch(/^1:05.*boundary/);
  });

  it("shows notes", () => {
    evalState = { data: makeEval([makeAxis({ matched: false })], "compromised") };
    renderPanel();
    expect(screen.getByText("These scores are optimistic: frames of this video were used for training.")).toBeInTheDocument();
    expect(screen.getByText("This axis has no matching reference axis.")).toBeInTheDocument();
  });

  it("shows the no-reference message and sends no request", () => {
    evalState = {};
    renderPanel({ hasReference: false });
    expect(screen.getByText("Label this video's reference to score the model")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/qc/reference/9");
    expect(useEvaluation).toHaveBeenCalledWith(7, 0, false);
  });

  it("shows loading and error states", () => {
    evalState = { isPending: true };
    const { unmount } = render(
      <MemoryRouter><EvaluationPanel runId={7} videoId={9} hasReference onSeek={vi.fn()} /></MemoryRouter>,
    );
    expect(screen.getByText("Scoring…")).toBeInTheDocument();
    unmount();
    evalState = { isError: true, error: { detail: "Run not found" } };
    const second = render(
      <MemoryRouter><EvaluationPanel runId={7} videoId={9} hasReference onSeek={vi.fn()} /></MemoryRouter>,
    );
    expect(screen.getByText("Run not found")).toBeInTheDocument();
    second.unmount();
    evalState = { isError: true, error: { detail: [{ msg: "x" }] } };
    renderPanel();
    expect(screen.getByText("Could not score this run.")).toBeInTheDocument();
  });

  it("converts the tolerance from seconds to milliseconds", () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText("Boundary tolerance (s)"), { target: { value: "2.5" } });
    expect(useEvaluation).toHaveBeenLastCalledWith(7, 2500, true);
  });

  it("switches axes", async () => {
    evalState = { data: makeEval([makeAxis(), makeAxis({ name: "Anatomy", frames_evaluated: 3, frames_excluded: 9 })]) };
    renderPanel();
    await userEvent.selectOptions(screen.getByLabelText("Axis"), "Anatomy");
    expect(screen.getByText(/3 evaluated/)).toBeInTheDocument();
  });

  it("caps the episode list at 200 and shows more", async () => {
    const many = Array.from({ length: 250 }, (_, i) => ep(i * 1000, 1, 0.5));
    evalState = { data: makeEval([makeAxis({ episodes: many })]) };
    renderPanel();
    expect(screen.getAllByRole("button", { name: /Polyp → Fold/ })).toHaveLength(200);
    await userEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getAllByRole("button", { name: /Polyp → Fold/ })).toHaveLength(250);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });
});
