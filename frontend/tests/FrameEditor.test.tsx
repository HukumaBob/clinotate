import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { describeJobBanner, FrameEditor } from "../src/features/annotation/FrameEditor";

const TAXONOMY_TREE = [
  {
    category: { id: 1, name: "lesion", procedure_id: 9 },
    evaluation_types: [
      {
        evaluation_type: { id: 1, name: "geometric" },
        labels: [{ id: 2, name: "0-Ip", color: "#f00", category_id: 1, evaluation_type_id: 1, taxonomy_version: 1 }],
      },
    ],
  },
];

const FRAMES = [
  { id: 41, sequence_id: 9, storage_key: "frames/9/41.png", frame_index: 0, width: 400, height: 200, image_url: "https://example.test/f41.png" },
  { id: 42, sequence_id: 9, storage_key: "frames/9/42.png", frame_index: 1, width: 400, height: 200, image_url: "https://example.test/f42.png" },
  { id: 43, sequence_id: 9, storage_key: "frames/9/43.png", frame_index: 2, width: 400, height: 200, image_url: "https://example.test/f43.png" },
];

function renderEditor(
  frameId = 42,
  onClose = vi.fn(),
  onFrameChange = vi.fn(),
  jobData?: { status: string; progress: number; error: string | null },
  maxTrackRangeFrames = 20,
) {
  vi.restoreAllMocks();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockImplementation((async (path: string, options?: { params?: { path?: { frame_id?: number } } }) => {
    if (path === "/media/frames/{frame_id}") {
      const requestedId = options?.params?.path?.frame_id ?? frameId;
      const match = FRAMES.find((f) => f.id === requestedId) ?? FRAMES[1];
      return { data: match, error: undefined, response: new Response() };
    }
    if (path === "/annotation/frames/{frame_id}/annotations") {
      return { data: [], error: undefined, response: new Response() };
    }
    if (path === "/taxonomy/tree") {
      return { data: TAXONOMY_TREE, error: undefined, response: new Response() };
    }
    if (path === "/media/sequences/{sequence_id}") {
      return { data: { id: 9, procedure_id: 9, video_id: null, start_time: 0, duration: 0 }, error: undefined, response: new Response() };
    }
    if (path === "/settings") {
      return {
        data: { max_track_range_frames: maxTrackRangeFrames, mask_postprocess_strength: 0.3 },
        error: undefined,
        response: new Response(),
      };
    }
    if (path === "/jobs/{job_id}") {
      if (!jobData) return { data: undefined, error: undefined, response: new Response() };
      return {
        data: {
          id: 1,
          job_type: "sam2_predict",
          status: jobData.status,
          progress: jobData.progress,
          result_ref: null,
          error: jobData.error,
          created_by_id: 1,
          started_at: null,
          finished_at: null,
        },
        error: undefined,
        response: new Response(),
      };
    }
    return { data: undefined, error: "not mocked", response: new Response() };
  }) as never);
  vi.spyOn(apiClient, "POST").mockResolvedValue({
    data: { id: 1, job_type: "sam2_predict", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
    error: undefined,
    response: new Response(),
  } as never);

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <FrameEditor frameId={frameId} frames={FRAMES} onClose={onClose} onFrameChange={onFrameChange} />
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

describe("FrameEditor", () => {
  it("renders the canvas and tools panel once the frame loads", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: "SAM 2.1" })).toBeInTheDocument();
  });

  it("calls onClose when Back to grid is clicked", async () => {
    const onClose = vi.fn();
    renderEditor(42, onClose);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /back to grid/i }));

    expect(onClose).toHaveBeenCalled();
  });

  it("shows Frame 2 of 3 and calls onFrameChange with the next frame's id when Next is clicked", async () => {
    const onFrameChange = vi.fn();
    renderEditor(42, vi.fn(), onFrameChange);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    expect(screen.getByLabelText("Frame number")).toHaveValue(2);

    await userEvent.click(screen.getByRole("button", { name: /^next/i }));
    expect(onFrameChange).toHaveBeenCalledWith(43);
  });

  it("calls onFrameChange with the previous frame's id when Prev is clicked", async () => {
    const onFrameChange = vi.fn();
    renderEditor(42, vi.fn(), onFrameChange);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^prev/i }));
    expect(onFrameChange).toHaveBeenCalledWith(41);
  });

  it("disables Prev on the first frame and Next on the last frame", async () => {
    const onFrameChange = vi.fn();
    renderEditor(41, vi.fn(), onFrameChange);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^prev/i })).toBeDisabled();
  });

  it("navigates to the next frame on ArrowRight keydown", async () => {
    const onFrameChange = vi.fn();
    renderEditor(42, vi.fn(), onFrameChange);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "ArrowRight" });

    expect(onFrameChange).toHaveBeenCalledWith(43);
  });

  it("submits a SAM 2.1 predict job immediately when a point is clicked with a label selected", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    await waitFor(() =>
      expect(apiClient.POST).toHaveBeenCalledWith(
        "/jobs/sam2/predict",
        expect.objectContaining({
          body: expect.objectContaining({
            frame_id: 42,
            label_id: 2,
            prompts: [{ type: "point", coords: [0.5, 0.5], label: true }],
          }),
        }),
      ),
    );
  });

  it("does not submit a predict job on a point click when no label is selected", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    expect(apiClient.POST).not.toHaveBeenCalledWith("/jobs/sam2/predict", expect.anything());
  });

  it("submits the full accumulated prompt set (not just the latest gesture) on a second refinement click", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });

    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseDown(canvas, { clientX: 40, clientY: 20, button: 0, shiftKey: true });
    fireEvent.mouseUp(canvas, { clientX: 40, clientY: 20, button: 0, shiftKey: true });

    await waitFor(() =>
      expect(apiClient.POST).toHaveBeenLastCalledWith(
        "/jobs/sam2/predict",
        expect.objectContaining({
          body: expect.objectContaining({
            prompts: [
              { type: "point", coords: [0.5, 0.5], label: true },
              { type: "point", coords: [0.1, 0.1], label: false },
            ],
          }),
        }),
      ),
    );
  });

  it("keeps the selected label tag when navigating to another frame", async () => {
    const { rerender } = renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    expect(screen.getByLabelText("Tag")).toHaveValue("2");

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <FrameEditor frameId={43} frames={FRAMES} onClose={vi.fn()} onFrameChange={vi.fn()} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Frame number")).toHaveValue(3));
    await waitFor(() => expect(screen.getByLabelText("Tag")).toHaveValue("2"));
  });

  it("clears pending point prompts when navigating to another frame", async () => {
    const { rerender } = renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    await waitFor(() => expect(screen.getByRole("button", { name: /^track$/i })).toBeEnabled());

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <FrameEditor frameId={43} frames={FRAMES} onClose={vi.fn()} onFrameChange={vi.fn()} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Frame number")).toHaveValue(3));
    expect(screen.getByRole("button", { name: /^track$/i })).toBeDisabled();
  });

  it("Track submits the accumulated pendingPrompts, not an empty list, after prior point clicks", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    await waitFor(() =>
      expect(apiClient.POST).toHaveBeenCalledWith("/jobs/sam2/predict", expect.anything()),
    );

    await userEvent.click(screen.getByRole("button", { name: /^track$/i }));

    await waitFor(() =>
      expect(apiClient.POST).toHaveBeenCalledWith(
        "/jobs/sam2/track",
        expect.objectContaining({
          body: expect.objectContaining({
            prompts: [{ type: "point", coords: [0.5, 0.5], label: true }],
          }),
        }),
      ),
    );
  });

  it("re-clamps backward/forward right before sending, even if the store holds a stale over-cap value", async () => {
    const { queryClient } = renderEditor(42, vi.fn(), vi.fn(), undefined, 20);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });
    await waitFor(() =>
      expect(apiClient.POST).toHaveBeenCalledWith("/jobs/sam2/predict", expect.anything()),
    );

    // Frame 42 has only 1 frame ahead of it, so forward defaulted to 1 --
    // set it directly via the input up to that per-sequence bound.
    fireEvent.change(screen.getByLabelText("Backward"), { target: { value: "1" } });

    // Simulate the settings query resolving to a lower cap than what the
    // store's current backward+forward already satisfied (e.g. an admin
    // lowered it between page load and now) -- the settings query mock now
    // reports a cap of 1, while the store still holds backward=1, forward=1
    // (total=2), a combination that was valid a moment ago but no longer is.
    vi.spyOn(apiClient, "GET").mockImplementation((async (path: string, options?: { params?: { path?: { frame_id?: number } } }) => {
      if (path === "/media/frames/{frame_id}") {
        const match = FRAMES.find((f) => f.id === (options?.params?.path?.frame_id ?? 42)) ?? FRAMES[1];
        return { data: match, error: undefined, response: new Response() };
      }
      if (path === "/annotation/frames/{frame_id}/annotations") {
        return { data: [], error: undefined, response: new Response() };
      }
      if (path === "/taxonomy/tree") {
        return { data: TAXONOMY_TREE, error: undefined, response: new Response() };
      }
      if (path === "/media/sequences/{sequence_id}") {
        return { data: { id: 9, procedure_id: 9, video_id: null, start_time: 0, duration: 0 }, error: undefined, response: new Response() };
      }
      if (path === "/settings") {
        return {
          data: { max_track_range_frames: 1, mask_postprocess_strength: 0.3 },
          error: undefined,
          response: new Response(),
        };
      }
      return { data: undefined, error: undefined, response: new Response() };
    }) as never);
    await queryClient.invalidateQueries({ queryKey: ["settings"] });
    await waitFor(() => expect(screen.getByText(/capped at 1 frames/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^track$/i }));

    await waitFor(() =>
      expect(apiClient.POST).toHaveBeenCalledWith(
        "/jobs/sam2/track",
        expect.objectContaining({
          body: expect.objectContaining({
            backward: expect.any(Number),
            forward: expect.any(Number),
          }),
        }),
      ),
    );
    const trackCall = vi
      .mocked(apiClient.POST)
      .mock.calls.find(([path]) => path === "/jobs/sam2/track");
    const body = trackCall?.[1]?.body as { backward: number; forward: number };
    expect(body.backward + body.forward).toBeLessThanOrEqual(1);
  });
});

describe("FrameEditor Track backward/forward defaults", () => {
  it("defaults backward to 0 and forward to the rest of the sequence", async () => {
    renderEditor(42);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    expect(screen.getByLabelText("Backward")).toHaveValue(0);
    // Frame 42 is index 1 of 3 (0-indexed) -- one frame (43) remains ahead.
    expect(screen.getByLabelText("Forward")).toHaveValue(1);
  });

  it("recomputes forward to the new rest-of-sequence length after navigating frames", async () => {
    const { rerender } = renderEditor(41);

    await waitFor(() => expect(screen.getByLabelText("Forward")).toHaveValue(2));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <FrameEditor frameId={43} frames={FRAMES} onClose={vi.fn()} onFrameChange={vi.fn()} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Frame number")).toHaveValue(3));
    expect(screen.getByLabelText("Forward")).toHaveValue(0);
  });

  it("clamps backward down when navigating to a frame with fewer frames available behind it", async () => {
    const { rerender } = renderEditor(43);

    // Frame 43 is index 2 of 3 -- two frames (41, 42) are available behind it.
    await waitFor(() => expect(screen.getByLabelText("Backward")).toHaveValue(0));
    fireEvent.change(screen.getByLabelText("Backward"), { target: { value: "2" } });
    expect(screen.getByLabelText("Backward")).toHaveValue(2);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <FrameEditor frameId={41} frames={FRAMES} onClose={vi.fn()} onFrameChange={vi.fn()} />
      </QueryClientProvider>,
    );

    // Frame 41 is index 0 -- no frames available behind it, so the
    // previously-set backward=2 must be clamped down to 0.
    await waitFor(() => expect(screen.getByLabelText("Frame number")).toHaveValue(1));
    expect(screen.getByLabelText("Backward")).toHaveValue(0);
  });

  it("re-clamps forward once the settings query resolves, without requiring a frame change", async () => {
    vi.restoreAllMocks();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    // A deferred /settings response -- the per-frame effect that sets
    // Forward runs on the very first render, before this resolves, so
    // Forward initially defaults to the full per-sequence bound (2, for
    // frame 41) with no cap applied (combinedCap falls back to Infinity
    // while settingsQuery.data is undefined).
    let resolveSettings!: (value: {
      data: { max_track_range_frames: number; mask_postprocess_strength: number };
    }) => void;
    const settingsPromise = new Promise<{
      data: { max_track_range_frames: number; mask_postprocess_strength: number };
    }>((resolve) => {
      resolveSettings = resolve;
    });

    vi.spyOn(apiClient, "GET").mockImplementation((async (path: string, options?: { params?: { path?: { frame_id?: number } } }) => {
      if (path === "/media/frames/{frame_id}") {
        const match = FRAMES.find((f) => f.id === (options?.params?.path?.frame_id ?? 41)) ?? FRAMES[0];
        return { data: match, error: undefined, response: new Response() };
      }
      if (path === "/annotation/frames/{frame_id}/annotations") {
        return { data: [], error: undefined, response: new Response() };
      }
      if (path === "/taxonomy/tree") {
        return { data: TAXONOMY_TREE, error: undefined, response: new Response() };
      }
      if (path === "/media/sequences/{sequence_id}") {
        return { data: { id: 9, procedure_id: 9, video_id: null, start_time: 0, duration: 0 }, error: undefined, response: new Response() };
      }
      if (path === "/settings") {
        const { data } = await settingsPromise;
        return { data, error: undefined, response: new Response() };
      }
      return { data: undefined, error: undefined, response: new Response() };
    }) as never);
    vi.spyOn(apiClient, "POST").mockResolvedValue({
      data: { id: 1, job_type: "sam2_predict", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
      response: new Response(),
    } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <FrameEditor frameId={41} frames={FRAMES} onClose={vi.fn()} onFrameChange={vi.fn()} />
      </QueryClientProvider>,
    );

    // Before the settings query resolves, Forward defaults to the full
    // per-sequence bound (2), uncapped.
    await waitFor(() => expect(screen.getByLabelText("Forward")).toHaveValue(2));

    // Now the settings query resolves to a cap (1) lower than that
    // uncapped default -- Forward must come down to fit it, without the
    // user navigating to a different frame.
    resolveSettings({ data: { max_track_range_frames: 1, mask_postprocess_strength: 0.3 } });
    await waitFor(() => expect(screen.getByLabelText("Forward")).toHaveValue(1));
  });
});

describe("FrameEditor frame-number input", () => {
  it("shows the current frame position in a numeric input", async () => {
    renderEditor(42);

    const input = await screen.findByLabelText("Frame number");
    expect(input).toHaveValue(2);
  });

  it("calls onFrameChange with the target frame id when a new number is entered and committed", async () => {
    const onFrameChange = vi.fn();
    renderEditor(41, vi.fn(), onFrameChange);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Frame number");
    await user.clear(input);
    await user.type(input, "3{Enter}");

    expect(onFrameChange).toHaveBeenCalledWith(43);
  });

  it("clamps out-of-range input to the last frame", async () => {
    const onFrameChange = vi.fn();
    renderEditor(41, vi.fn(), onFrameChange);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Frame number");
    await user.clear(input);
    await user.type(input, "999{Enter}");

    expect(onFrameChange).toHaveBeenCalledWith(43);
  });

  it("clamps out-of-range input to the first frame", async () => {
    const onFrameChange = vi.fn();
    renderEditor(42, vi.fn(), onFrameChange);
    const user = userEvent.setup();

    const input = await screen.findByLabelText("Frame number");
    await user.clear(input);
    await user.type(input, "0{Enter}");

    expect(onFrameChange).toHaveBeenCalledWith(41);
  });
});

describe("FrameEditor job status", () => {
  it("shows no spinner and no error notice when there is no active job", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    expect(screen.queryByRole("status", { name: "Job in progress" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("describeJobBanner", () => {
  it("returns a spinner banner while pending or running", () => {
    expect(describeJobBanner({ status: "pending", progress: 0, error: null })).toEqual({ kind: "progress", progress: 0 });
    expect(describeJobBanner({ status: "running", progress: 40, error: null })).toEqual({ kind: "progress", progress: 40 });
  });

  it("returns an error banner when failed, using the job's error text", () => {
    expect(describeJobBanner({ status: "failed", progress: 0, error: "OOM" })).toEqual({ kind: "error", message: "OOM" });
  });

  it("falls back to a generic message when failed with no error text", () => {
    expect(describeJobBanner({ status: "failed", progress: 0, error: null })).toEqual({
      kind: "error",
      message: "The job failed.",
    });
  });

  it("returns null once succeeded", () => {
    expect(describeJobBanner({ status: "succeeded", progress: 100, error: null })).toBeNull();
  });

  it("returns null when there is no job", () => {
    expect(describeJobBanner(undefined)).toBeNull();
  });
});

describe("FrameEditor VRAM gauge staleness", () => {
  it("keeps showing the last known VRAM reading after a job finishes, dimmed", async () => {
    vi.restoreAllMocks();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let jobStatus: "running" | "succeeded" = "running";

    vi.spyOn(apiClient, "GET").mockImplementation((async (
      path: string,
      options?: { params?: { path?: { frame_id?: number } } },
    ) => {
      if (path === "/media/frames/{frame_id}") {
        const requestedId = options?.params?.path?.frame_id ?? 42;
        const match = FRAMES.find((f) => f.id === requestedId) ?? FRAMES[1];
        return { data: match, error: undefined, response: new Response() };
      }
      if (path === "/annotation/frames/{frame_id}/annotations") {
        return { data: [], error: undefined, response: new Response() };
      }
      if (path === "/taxonomy/tree") {
        return { data: TAXONOMY_TREE, error: undefined, response: new Response() };
      }
      if (path === "/media/sequences/{sequence_id}") {
        return {
          data: { id: 9, procedure_id: 9, video_id: null, start_time: 0, duration: 0 },
          error: undefined,
          response: new Response(),
        };
      }
      if (path === "/jobs/{job_id}") {
        return {
          data: {
            id: 1,
            job_type: "sam2_predict",
            status: jobStatus,
            progress: jobStatus === "succeeded" ? 100 : 40,
            vram_used_bytes: 4 * 1024 ** 3,
            vram_total_bytes: 8 * 1024 ** 3,
            result_ref: null,
            error: null,
            created_by_id: 1,
            started_at: null,
            finished_at: null,
          },
          error: undefined,
          response: new Response(),
        };
      }
      return { data: undefined, error: "not mocked", response: new Response() };
    }) as never);
    vi.spyOn(apiClient, "POST").mockResolvedValue({
      data: {
        id: 1,
        job_type: "sam2_predict",
        status: "pending",
        progress: 0,
        result_ref: null,
        error: null,
        created_by_id: 1,
        started_at: null,
        finished_at: null,
      },
      error: undefined,
      response: new Response(),
    } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <FrameEditor frameId={42} frames={FRAMES} onClose={vi.fn()} onFrameChange={vi.fn()} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    await waitFor(() =>
      expect(apiClient.POST).toHaveBeenCalledWith("/jobs/sam2/predict", expect.anything()),
    );

    await waitFor(() => expect(screen.getByText("4.0 / 8.0 GiB")).toBeInTheDocument());
    expect(screen.getByTestId("vram-gauge")).not.toHaveClass("opacity-50");

    jobStatus = "succeeded";

    await waitFor(() => expect(screen.getByTestId("vram-gauge")).toHaveClass("opacity-50"), { timeout: 3000 });
    expect(screen.getByText("4.0 / 8.0 GiB")).toBeInTheDocument();
  });
});
