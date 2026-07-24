import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { MasksList } from "../src/features/annotation/MasksList";

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
