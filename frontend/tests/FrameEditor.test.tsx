import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { FrameEditor } from "../src/features/annotation/FrameEditor";

const LABEL_TREE = [
  {
    category: { id: 1, name: "lesion", label_type: "geometric", color: "#fff", procedure_id: null, taxonomy_version: 1 },
    children: [
      { id: 2, name: "0-Ip", label_type: "geometric", color: "#f00", procedure_id: null, taxonomy_version: 1 },
    ],
  },
];

const FRAMES = [
  { id: 41, sequence_id: 9, storage_key: "frames/9/41.png", frame_index: 0, width: 400, height: 200, image_url: "https://example.test/f41.png" },
  { id: 42, sequence_id: 9, storage_key: "frames/9/42.png", frame_index: 1, width: 400, height: 200, image_url: "https://example.test/f42.png" },
  { id: 43, sequence_id: 9, storage_key: "frames/9/43.png", frame_index: 2, width: 400, height: 200, image_url: "https://example.test/f43.png" },
];

function renderEditor(frameId = 42, onClose = vi.fn(), onFrameChange = vi.fn()) {
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
    if (path === "/taxonomy/labels/tree") {
      return { data: LABEL_TREE, error: undefined, response: new Response() };
    }
    return { data: undefined, error: "not mocked", response: new Response() };
  }) as never);
  vi.spyOn(apiClient, "POST").mockResolvedValue({
    data: { id: 1, job_type: "sam2_predict", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
    error: undefined,
    response: new Response(),
  } as never);

  return render(
    <QueryClientProvider client={queryClient}>
      <FrameEditor frameId={frameId} frames={FRAMES} onClose={onClose} onFrameChange={onFrameChange} />
    </QueryClientProvider>,
  );
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
    expect(screen.getByText("Frame 2 of 3")).toBeInTheDocument();

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
});
