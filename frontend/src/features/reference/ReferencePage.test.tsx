import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReferencePage } from "./ReferencePage";

let referenceState: { data?: Record<string, unknown>; isError?: boolean; isPending?: boolean };
let videoState: Record<string, unknown>;
let saveState: string;

vi.mock("../../entities/useReference", () => ({
  useReference: () => referenceState,
  useRestoreClean: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../entities/useVideo", () => ({
  useVideo: () => ({ data: videoState, refetch: vi.fn() }),
}));
vi.mock("../media/TranscodePrompt", () => ({
  TranscodePrompt: () => <p>Transcode prompt</p>,
}));
vi.mock("./useReferenceEditor", () => ({
  toRefAxes: (reference: { axes: { category_id: number; name: string; classes: { label_id: number; name: string; key: string | null }[] }[] }) =>
    reference.axes.map((a) => ({
      categoryId: a.category_id,
      name: a.name,
      classes: a.classes.map((c) => ({ labelId: c.label_id, name: c.name, key: c.key })),
    })),
  useReferenceEditor: () => ({
    intervals: [],
    growing: {},
    selectedId: null,
    select: vi.fn(),
    pressClass: vi.fn(),
    closeAll: vi.fn(),
    deleteSelected: vi.fn(),
    dragEdge: vi.fn(),
    saveState,
  }),
}));

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/qc/reference/9"]}>
      <Routes>
        <Route path="/qc/reference/:videoId" element={<ReferencePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  saveState = "idle";
  referenceState = {
    data: {
      video_id: 9, procedure_id: 1, duration_ms: 10000, status: "clean", compromised_at: null,
      compromised_by_training_run_id: null,
      axes: [{ category_id: 2, name: "Location", classes: [{ label_id: 10, name: "Antrum", key: "1" }] }],
      intervals: [],
    },
  };
  videoState = { id: 9, title: "Gastroscopy 1", stream_url: "/v.mp4", duration_seconds: 10, browser_playable: true };
});

describe("ReferencePage", () => {
  it("shows the legend, lanes and status for a video with axes", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: /Gastroscopy 1/ })).toBeInTheDocument();
    expect(screen.getByText("Antrum")).toBeInTheDocument();
    expect(screen.getByTestId("lane-2")).toBeInTheDocument();
    expect(screen.getByText("Clean")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to QC/ })).toHaveAttribute("href", "/qc");
  });

  it("shows a plain message when the video has no axes", () => {
    (referenceState.data as { axes: unknown[] }).axes = [];
    renderPage();
    expect(
      screen.getByText("This video has no procedure or its procedure has no frame-classification labels"),
    ).toBeInTheDocument();
  });

  it("shows the transcode prompt for a non-playable video", () => {
    videoState.browser_playable = false;
    renderPage();
    expect(screen.getByText("Transcode prompt")).toBeInTheDocument();
  });

  it("shows an error when the reference cannot be loaded", () => {
    referenceState = { isError: true };
    renderPage();
    expect(screen.getByText("This video's reference could not be loaded.")).toBeInTheDocument();
  });

  it("flags unsaved edits", () => {
    saveState = "error";
    renderPage();
    expect(screen.getByText(/not saved/i)).toBeInTheDocument();
  });
});
