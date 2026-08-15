import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { CascadingLabelPicker } from "../src/features/annotation/CascadingLabelPicker";

afterEach(() => {
  vi.restoreAllMocks();
});

const TREE = [
  {
    category: { id: 1, name: "Anatomy", procedure_id: 5 },
    evaluation_types: [
      {
        evaluation_type: { id: 100, name: "geometric", annotation_scope: "region" },
        labels: [{ id: 10, name: "pharynx", color: "#2E81DA", category_id: 1, evaluation_type_id: 100, taxonomy_version: 1 }],
      },
    ],
  },
  {
    category: { id: 2, name: "Findings", procedure_id: 5 },
    evaluation_types: [
      {
        evaluation_type: { id: 200, name: "morphological", annotation_scope: "region" },
        labels: [{ id: 20, name: "colon_adenoma", color: "#DA352E", category_id: 2, evaluation_type_id: 200, taxonomy_version: 1 }],
      },
    ],
  },
];

function renderPicker(procedureId: number | null = 5) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
  const store = createFrameEditorStore();
  render(
    <QueryClientProvider client={queryClient}>
      <CascadingLabelPicker store={store} procedureId={procedureId} />
    </QueryClientProvider>,
  );
  return store;
}

describe("CascadingLabelPicker", () => {
  it("lists categories from the taxonomy tree", async () => {
    renderPicker();

    expect(await screen.findByRole("option", { name: "Anatomy" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Findings" })).toBeInTheDocument();
  });

  it("selecting a category populates evaluation type options from the tree, not derived label_type strings", async () => {
    renderPicker();
    const user = userEvent.setup();

    await screen.findByRole("option", { name: "Anatomy" });
    await user.selectOptions(screen.getByLabelText("Category"), "1");

    expect(screen.getByRole("option", { name: "geometric" })).toBeInTheDocument();
  });

  it("selecting category and evaluation type populates tag options from that branch's labels", async () => {
    renderPicker();
    const user = userEvent.setup();

    await screen.findByRole("option", { name: "Anatomy" });
    await user.selectOptions(screen.getByLabelText("Category"), "1");
    await user.selectOptions(screen.getByLabelText("Classification"), "100");

    expect(screen.getByRole("option", { name: "pharynx" })).toBeInTheDocument();
  });

  it("does not fetch the tree when procedureId is null", () => {
    const store = createFrameEditorStore();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(apiClient, "GET").mockResolvedValue({ data: [], error: undefined, response: new Response() } as never);

    render(
      <QueryClientProvider client={queryClient}>
        <CascadingLabelPicker store={store} procedureId={null} />
      </QueryClientProvider>,
    );

    expect(spy).not.toHaveBeenCalled();
  });
});
