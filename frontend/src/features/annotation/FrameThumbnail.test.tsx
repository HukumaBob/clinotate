import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { FrameThumbnail } from "./FrameThumbnail";
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

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

describe("FrameThumbnail", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders the resolved category/label name instead of a bare label id", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 1,
          frame_id: 5,
          label_id: 100,
          taxonomy_version: 1,
          annotation_type: "mask",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: null,
          job_id: null,
        },
      ],
      error: undefined,
    } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    expect(await screen.findByText("Polyp / Sessile")).toBeInTheDocument();
  });

  it("falls back to 'label <id>' when the label isn't in the taxonomy tree", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 1,
          frame_id: 5,
          label_id: 999,
          taxonomy_version: 1,
          annotation_type: "mask",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: null,
          job_id: null,
        },
      ],
      error: undefined,
    } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    expect(await screen.findByText("label 999")).toBeInTheDocument();
  });

  it("renders no caption bar when there are no annotations", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    await screen.findByAltText("Frame 5");
    expect(screen.queryByText(/label/)).not.toBeInTheDocument();
  });

  it("renders a mask overlay div for each mask annotation with a mask_url, tinted by its label color", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 1,
          frame_id: 5,
          label_id: 100,
          taxonomy_version: 1,
          annotation_type: "mask",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: "http://example.com/mask-1.png",
          job_id: null,
        },
      ],
      error: undefined,
    } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    const overlays = await screen.findAllByTestId("mask-overlay");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toHaveStyle({ backgroundColor: "#ff0000" });
    expect(overlays[0].style.maskImage).toContain("http://example.com/mask-1.png");
  });

  it("renders one overlay div per mask annotation when a frame has multiple masks", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 1,
          frame_id: 5,
          label_id: 100,
          taxonomy_version: 1,
          annotation_type: "mask",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: "http://example.com/mask-1.png",
          job_id: null,
        },
        {
          id: 2,
          frame_id: 5,
          label_id: 999,
          taxonomy_version: 1,
          annotation_type: "mask",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: "http://example.com/mask-2.png",
          job_id: null,
        },
      ],
      error: undefined,
    } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    const overlays = await screen.findAllByTestId("mask-overlay");
    expect(overlays).toHaveLength(2);
  });

  it("does not render an overlay for annotations without a mask_url (e.g. bbox)", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 1,
          frame_id: 5,
          label_id: 100,
          taxonomy_version: 1,
          annotation_type: "bbox",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: null,
          job_id: null,
        },
      ],
      error: undefined,
    } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    await screen.findByText("Polyp / Sessile");
    expect(screen.queryByTestId("mask-overlay")).not.toBeInTheDocument();
  });
});
