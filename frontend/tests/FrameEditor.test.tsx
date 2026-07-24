import { render, screen, waitFor } from "@testing-library/react";
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

function renderEditor(onClose = vi.fn()) {
  vi.restoreAllMocks();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockImplementation((async (path: string) => {
    if (path === "/media/frames/{frame_id}") {
      return {
        data: { id: 42, sequence_id: 9, storage_key: "frames/9/42.png", frame_index: 42, width: 400, height: 200, image_url: "https://example.test/f42.png" },
        error: undefined,
        response: new Response(),
      };
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
      <FrameEditor frameId={42} onClose={onClose} />
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
    renderEditor(onClose);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /back to grid/i }));

    expect(onClose).toHaveBeenCalled();
  });

  it("submits a SAM 2.1 predict job when Add mask is clicked with a pending point prompt", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());

    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    await userEvent.click(screen.getByRole("button", { name: "Add mask" }));

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

  it("refetches annotations once the polled job succeeds", async () => {
    let jobStatus: "pending" | "succeeded" = "pending";
    let annotationsCallCount = 0;
    vi.restoreAllMocks();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockImplementation((async (path: string) => {
      if (path === "/media/frames/{frame_id}") {
        return {
          data: { id: 42, sequence_id: 9, storage_key: "frames/9/42.png", frame_index: 42, width: 400, height: 200, image_url: "https://example.test/f42.png" },
          error: undefined,
          response: new Response(),
        };
      }
      if (path === "/annotation/frames/{frame_id}/annotations") {
        annotationsCallCount += 1;
        return { data: [], error: undefined, response: new Response() };
      }
      if (path === "/taxonomy/labels/tree") {
        return { data: LABEL_TREE, error: undefined, response: new Response() };
      }
      if (path === "/jobs/{job_id}") {
        return {
          data: { id: 1, job_type: "sam2_predict", status: jobStatus, progress: jobStatus === "succeeded" ? 100 : 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
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

    render(
      <QueryClientProvider client={queryClient}>
        <FrameEditor frameId={42} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    await userEvent.click(screen.getByRole("button", { name: "Add mask" }));
    await waitFor(() => expect(apiClient.POST).toHaveBeenCalledWith("/jobs/sam2/predict", expect.anything()));

    const callsBeforeSuccess = annotationsCallCount;
    jobStatus = "succeeded";

    await waitFor(() => expect(annotationsCallCount).toBeGreaterThan(callsBeforeSuccess), { timeout: 3000 });
  });

  it("does not submit a predict job when Add mask is clicked with no label selected", async () => {
    renderEditor();

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());

    const canvas = screen.getByTestId("frame-canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, width: 400, height: 200 }),
    });
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.mouseDown(canvas, { clientX: 200, clientY: 100, button: 0 });
    fireEvent.mouseUp(canvas, { clientX: 200, clientY: 100, button: 0 });

    await userEvent.click(screen.getByRole("button", { name: "Add mask" }));

    expect(apiClient.POST).not.toHaveBeenCalledWith("/jobs/sam2/predict", expect.anything());
  });
});
