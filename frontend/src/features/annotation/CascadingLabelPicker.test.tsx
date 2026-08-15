import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { CascadingLabelPicker } from "./CascadingLabelPicker";
import { createFrameEditorStore } from "./frameEditorStore";
import * as useTaxonomyTreeModule from "../../entities/useTaxonomyTree";

vi.mock("../../entities/useTaxonomyTree");

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const sampleTree = [
  {
    category: { id: 1, name: "Quality", procedure_id: 1 },
    evaluation_types: [
      {
        evaluation_type: { id: 9, name: "frame_classification", annotation_scope: "frame" },
        labels: [
          { id: 101, name: "low_quality", color: "#ff0000", category_id: 1, evaluation_type_id: 9, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z", parent_label_id: null, is_abstract: false },
        ],
      },
      {
        evaluation_type: { id: 10, name: "geometric", annotation_scope: "region" },
        labels: [
          { id: 102, name: "foam", color: "#00ff00", category_id: 1, evaluation_type_id: 10, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z", parent_label_id: null, is_abstract: false },
        ],
      },
    ],
  },
];

describe("CascadingLabelPicker", () => {
  afterEach(() => vi.clearAllMocks());

  it("only offers region-scoped evaluation types in the Classification dropdown", async () => {
    vi.mocked(useTaxonomyTreeModule.useTaxonomyTree).mockReturnValue({
      data: sampleTree,
    } as never);
    const store = createFrameEditorStore();
    const user = userEvent.setup();

    render(<CascadingLabelPicker store={store} procedureId={1} />, { wrapper });

    await user.selectOptions(screen.getByLabelText(/category/i), "1");

    const classificationSelect = screen.getByLabelText(/classification/i);
    const optionNames = Array.from(classificationSelect.querySelectorAll("option")).map((o) => o.textContent);
    expect(optionNames).toContain("geometric");
    expect(optionNames).not.toContain("frame_classification");
  });

  it("does not offer frame-scoped labels as tag options when no classification is selected", async () => {
    vi.mocked(useTaxonomyTreeModule.useTaxonomyTree).mockReturnValue({
      data: sampleTree,
    } as never);
    const store = createFrameEditorStore();
    const user = userEvent.setup();

    render(<CascadingLabelPicker store={store} procedureId={1} />, { wrapper });

    await user.selectOptions(screen.getByLabelText(/category/i), "1");

    const tagSelect = screen.getByLabelText(/^tag$/i);
    const tagOptionNames = Array.from(tagSelect.querySelectorAll("option")).map((o) => o.textContent);
    expect(tagOptionNames).toContain("foam");
    expect(tagOptionNames).not.toContain("low_quality");
  });

  it("does not offer abstract labels as tag options", async () => {
    const treeWithAbstractParent = [
      {
        category: { id: 1, name: "Findings", procedure_id: 1 },
        evaluation_types: [
          {
            evaluation_type: { id: 10, name: "geometric", annotation_scope: "region" },
            labels: [
              {
                id: 50,
                name: "polyp",
                color: "#FF0000",
                category_id: 1,
                evaluation_type_id: 10,
                taxonomy_version: 1,
                parent_label_id: null,
                is_abstract: true,
              },
              {
                id: 51,
                name: "sessile_polyp_0_Is",
                color: "#00FF00",
                category_id: 1,
                evaluation_type_id: 10,
                taxonomy_version: 1,
                parent_label_id: 50,
                is_abstract: false,
              },
            ],
          },
        ],
      },
    ];

    vi.mocked(useTaxonomyTreeModule.useTaxonomyTree).mockReturnValue({
      data: treeWithAbstractParent,
    } as never);
    const store = createFrameEditorStore();
    const user = userEvent.setup();

    render(<CascadingLabelPicker store={store} procedureId={1} />, { wrapper });

    await user.selectOptions(screen.getByLabelText(/category/i), "1");

    expect(await screen.findByRole("option", { name: "sessile_polyp_0_Is" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "polyp" })).not.toBeInTheDocument();
  });
});
