import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ReferencePage } from "./ReferencePage";

let referenceState: { data?: Record<string, unknown>; isError?: boolean; isPending?: boolean };
let videoState: Record<string, unknown>;
let videoQuery: { isPending?: boolean; isError?: boolean };
let saveState: string;
let restoreState: { error?: unknown; isError?: boolean };
let referenceArg: number | null | undefined;
let mounts: { videoId: number | null }[];
const deleteInterval = vi.fn();

vi.mock("../../entities/useReference", () => ({
  useReference: (videoId: number | null) => {
    referenceArg = videoId;
    return referenceState;
  },
  useRestoreClean: () => ({ mutate: vi.fn(), ...restoreState }),
  useDeleteInterval: () => ({ mutate: deleteInterval }),
}));
vi.mock("../../entities/useVideo", () => ({
  useVideo: () => ({ data: videoState, refetch: vi.fn(), ...videoQuery }),
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
  useReferenceEditor: ({ reference }: { reference?: { video_id: number } }) => {
    // One record per editor mount: a new video must get a new editor.
    const [mount] = useState(() => {
      const record = { videoId: reference?.video_id ?? null };
      mounts.push(record);
      return record;
    });
    void mount;
    return {
    intervals: [],
    growing: {},
    selectedId: null,
    select: vi.fn(),
    pressClass: vi.fn(),
    closeAll: vi.fn(),
    deleteSelected: vi.fn(),
    dragEdge: vi.fn(),
    saveState,
    };
  },
}));

function GoTo10() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/qc/reference/10")}>
      go
    </button>
  );
}

function renderPage(path = "/qc/reference/9") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <GoTo10 />
      <Routes>
        <Route path="/qc/reference/:videoId" element={<ReferencePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  saveState = "idle";
  videoQuery = {};
  restoreState = {};
  referenceArg = undefined;
  mounts = [];
  deleteInterval.mockReset();
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
    expect(screen.getByRole("alert")).toHaveTextContent("Not saved: the change was undone.");
  });

  it("lists orphaned intervals and deletes one through the delete mutation", () => {
    const data = referenceState.data as { intervals: unknown[] };
    data.intervals = [
      { id: 31, video_id: 9, category_id: 2, label_id: 77, taxonomy_version: 1, start_ms: 2000, end_ms: 4000, orphaned: true },
      { id: 32, video_id: 9, category_id: 2, label_id: 10, taxonomy_version: 1, start_ms: 5000, end_ms: 6000, orphaned: false },
    ];
    renderPage();
    expect(screen.getByText(/1 orphaned interval/)).toBeInTheDocument();
    expect(screen.getByText(/Label #77 0:02–0:04/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteInterval).toHaveBeenCalledWith(31);
  });

  it("shows why restoring clean failed", () => {
    restoreState = { isError: true, error: { detail: "Video 9 has no reference" } };
    renderPage();
    expect(screen.getByRole("alert")).toHaveTextContent("Video 9 has no reference");
  });

  it("says it is loading while the reference or the video is pending", () => {
    referenceState = { isPending: true };
    const first = renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    first.unmount();
    referenceState = { data: referenceState.data };
    videoQuery = { isPending: true };
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("says so when only the video fails to load", () => {
    videoQuery = { isError: true };
    videoState = undefined as unknown as Record<string, unknown>;
    renderPage();
    expect(screen.getByText("This video could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText("This video's reference could not be loaded.")).toBeNull();
  });

  it("treats a non-numeric video id as a reference that cannot be loaded", () => {
    referenceState = {};
    renderPage("/qc/reference/abc");
    expect(referenceArg).toBeNull();
    expect(screen.getByText("This video's reference could not be loaded.")).toBeInTheDocument();
  });

  it("mounts a fresh editor for another video", () => {
    renderPage();
    expect(mounts).toEqual([{ videoId: 9 }]);
    (referenceState.data as { video_id: number }).video_id = 10;
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    expect(mounts).toEqual([{ videoId: 9 }, { videoId: 10 }]);
  });
});
