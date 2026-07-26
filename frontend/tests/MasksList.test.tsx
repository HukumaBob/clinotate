import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { MasksList } from "../src/features/annotation/MasksList";

afterEach(() => {
  vi.restoreAllMocks();
});

const TREE = [
  {
    category: { id: 1, name: "lesion", label_type: "geometric", color: "#fff", procedure_id: null, taxonomy_version: 1 },
    children: [
      { id: 2, name: "0-Ip", label_type: "geometric", color: "#f00", procedure_id: null, taxonomy_version: 1 },
    ],
  },
];

const ANNOTATIONS = [
  {
    id: 55,
    frame_id: 1,
    label_id: 2,
    taxonomy_version: 1,
    annotation_type: "mask",
    status: "draft",
    created_by_id: 1,
    reviewed_by_id: null,
    mask_url: "https://example.test/mask-55.png",
    job_id: null,
  },
];

describe("MasksList", () => {
  it("lists one row per mask annotation", async () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());
  });

  it("clicking a row selects the annotation and fills the label selection", async () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());
    await userEvent.click(screen.getByText("lesion / 0-Ip"));

    const state = store.getState();
    expect(state.selectedAnnotationId).toBe(55);
    expect(state.labelCategoryId).toBe(1);
    expect(state.labelTagId).toBe(2);
    expect(state.labelClassification).toBe("geometric");
  });
});

describe("MasksList delete", () => {
  it("shows a delete (x) control per row and calls the delete mutation with the annotation id when confirmed twice", async () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({ data: undefined, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} frameId={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());

    const deleteButton = screen.getByRole("button", { name: /delete mask/i });
    await userEvent.click(deleteButton);
    await userEvent.click(screen.getByRole("button", { name: /confirm delete/i }));

    await waitFor(() =>
      expect(apiClient.DELETE).toHaveBeenCalledWith(
        "/annotation/annotations/{annotation_id}",
        expect.objectContaining({ params: { path: { annotation_id: 55 } } }),
      ),
    );
  });

  it("does not delete on a single click, only after the confirm step", async () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({ data: undefined, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} frameId={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /delete mask/i }));

    expect(apiClient.DELETE).not.toHaveBeenCalled();
  });

  it("shows 'Delete all from this run' only for annotations with a job_id, and calls the bulk mutation when confirmed", async () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const annotationsWithJob = [{ ...ANNOTATIONS[0], job_id: 99 }];
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({
      data: { deleted_ids: [55] },
      error: undefined,
      response: new Response(),
    } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={annotationsWithJob as never} store={store} frameId={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());

    const bulkButton = screen.getByRole("button", { name: /delete all from this run/i });
    await userEvent.click(bulkButton);
    await userEvent.click(screen.getByRole("button", { name: /confirm delete all/i }));

    await waitFor(() =>
      expect(apiClient.DELETE).toHaveBeenCalledWith(
        "/annotation/jobs/{job_id}/annotations",
        expect.objectContaining({ params: { path: { job_id: 99 } } }),
      ),
    );
  });

  it("clears pendingPrompts when the deleted annotation is the current draft", async () => {
    const store = createFrameEditorStore();
    store.getState().addPrompt({ type: "point", coords: [0.5, 0.5], label: true });
    store.getState().setDraftAnnotationId(55);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({ data: undefined, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} frameId={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /delete mask/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm delete/i }));

    await waitFor(() => expect(apiClient.DELETE).toHaveBeenCalled());
    expect(store.getState().pendingPrompts).toHaveLength(0);
  });

  it("does NOT clear pendingPrompts when the deleted annotation is not the current draft", async () => {
    const store = createFrameEditorStore();
    store.getState().addPrompt({ type: "point", coords: [0.5, 0.5], label: true });
    store.getState().setDraftAnnotationId(999); // a different, unrelated draft
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
    vi.spyOn(apiClient, "DELETE").mockResolvedValue({ data: undefined, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} frameId={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /delete mask/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm delete/i }));

    await waitFor(() => expect(apiClient.DELETE).toHaveBeenCalled());
    expect(store.getState().pendingPrompts).toHaveLength(1);
  });

  it("does not show 'Delete all from this run' for an annotation with no job_id", async () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <MasksList annotations={ANNOTATIONS as never} store={store} frameId={1} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByText("lesion / 0-Ip")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /delete all from this run/i })).not.toBeInTheDocument();
  });
});
