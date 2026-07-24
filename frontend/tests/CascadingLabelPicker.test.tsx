import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { createFrameEditorStore } from "../src/features/annotation/frameEditorStore";
import { CascadingLabelPicker } from "../src/features/annotation/CascadingLabelPicker";

const TREE = [
  {
    category: { id: 1, name: "lesion", label_type: "geometric", color: "#fff", procedure_id: null, taxonomy_version: 1 },
    children: [
      { id: 2, name: "0-Ip", label_type: "geometric", color: "#f00", procedure_id: null, taxonomy_version: 1 },
      { id: 3, name: "scar", label_type: "morphological", color: "#0f0", procedure_id: null, taxonomy_version: 1 },
    ],
  },
];

function renderPicker(store = createFrameEditorStore()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(apiClient, "GET").mockResolvedValue({ data: TREE, error: undefined, response: new Response() } as never);
  render(
    <QueryClientProvider client={queryClient}>
      <CascadingLabelPicker store={store} />
    </QueryClientProvider>,
  );
  return store;
}

describe("CascadingLabelPicker", () => {
  it("lists categories, then filters children by classification, then lists tags", async () => {
    renderPicker();

    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");

    await userEvent.selectOptions(screen.getByLabelText("Classification"), "geometric");
    expect(screen.getByRole("option", { name: "0-Ip" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "scar" })).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");
  });

  it("writes the selection into the store", async () => {
    const store = renderPicker();

    await waitFor(() => expect(screen.getByRole("option", { name: "lesion" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Category"), "1");
    await userEvent.selectOptions(screen.getByLabelText("Classification"), "geometric");
    await userEvent.selectOptions(screen.getByLabelText("Tag"), "2");

    const state = store.getState();
    expect(state.labelCategoryId).toBe(1);
    expect(state.labelClassification).toBe("geometric");
    expect(state.labelTagId).toBe(2);
  });
});
