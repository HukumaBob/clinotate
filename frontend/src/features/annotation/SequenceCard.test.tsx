import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { SequenceCard } from "./SequenceCard";
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];
type SequenceListItem = components["schemas"]["SequenceListItem"];

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const TAXONOMY_TREE: TaxonomyTreeNode[] = [
  {
    category: { id: 1, name: "Polyp", procedure_id: 1 },
    evaluation_types: [
      {
        evaluation_type: { id: 10, name: "Morphology" },
        labels: [{ id: 100, name: "Sessile", color: "#ff0000", category_id: 1 }],
      },
    ],
  },
];

function buildSequence(overrides: Partial<SequenceListItem> = {}): SequenceListItem {
  return {
    id: 1,
    name: "test-sequence",
    video_id: null,
    procedure_id: 1,
    frame_count: 40,
    labeled_frame_count: 10,
    preview_frames: [
      { frame_id: 1, image_url: "http://example.com/1.png", annotations: [] },
      { frame_id: 2, image_url: "http://example.com/2.png", annotations: [] },
    ],
    ...overrides,
  };
}

describe("SequenceCard", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders the sequence name, frame count, and labeled count", () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);
    render(<SequenceCard sequence={buildSequence()} onAnnotate={() => {}} />, { wrapper });

    expect(screen.getByText("test-sequence")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
  });

  it("renders the labeling progress percentage", () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);
    render(
      <SequenceCard sequence={buildSequence({ frame_count: 40, labeled_frame_count: 10 })} onAnnotate={() => {}} />,
      { wrapper },
    );

    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("renders a preview thumbnail per preview frame", () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);
    render(<SequenceCard sequence={buildSequence()} onAnnotate={() => {}} />, { wrapper });

    expect(screen.getByAltText("Preview frame 1")).toBeInTheDocument();
    expect(screen.getByAltText("Preview frame 2")).toBeInTheDocument();
  });

  it("renders a mask overlay tinted by the label color for a preview frame's mask annotation", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: TAXONOMY_TREE, error: undefined } as never);
    const sequence = buildSequence({
      preview_frames: [
        {
          frame_id: 1,
          image_url: "http://example.com/1.png",
          annotations: [{ label_id: 100, mask_url: "http://example.com/mask.png" }],
        },
      ],
    });

    render(<SequenceCard sequence={sequence} onAnnotate={() => {}} />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("mask-overlay")).toHaveStyle({ backgroundColor: "#ff0000" });
    });
    const overlay = screen.getByTestId("mask-overlay");
    expect(overlay.style.maskImage).toContain("http://example.com/mask.png");
  });

  it("calls onAnnotate with the sequence id when the Annotate button is clicked", () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);
    const onAnnotate = vi.fn();
    render(<SequenceCard sequence={buildSequence({ id: 42 })} onAnnotate={onAnnotate} />, { wrapper });

    screen.getByRole("button", { name: "Annotate" }).click();

    expect(onAnnotate).toHaveBeenCalledWith(42);
  });
});
