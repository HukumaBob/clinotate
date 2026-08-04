import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { SequenceStatsPanel } from "./SequenceStatsPanel";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("SequenceStatsPanel", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows frame count and resolution once loaded", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { frame_count: 42, frame_width: 720, frame_height: 480, labels: [] },
      error: undefined,
    } as never);

    render(<SequenceStatsPanel sequenceId={9} />, { wrapper });

    expect(await screen.findByText("42 frames · 720×480")).toBeInTheDocument();
  });

  it("omits the resolution when frame_width/frame_height are null", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { frame_count: 0, frame_width: null, frame_height: null, labels: [] },
      error: undefined,
    } as never);

    render(<SequenceStatsPanel sequenceId={9} />, { wrapper });

    expect(await screen.findByText("0 frames")).toBeInTheDocument();
  });

  it("renders a row per label with its count", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        frame_count: 10,
        frame_width: 100,
        frame_height: 100,
        labels: [
          { label_name: "polyp", count: 5 },
          { label_name: "blood", count: 2 },
        ],
      },
      error: undefined,
    } as never);

    render(<SequenceStatsPanel sequenceId={9} />, { wrapper });

    expect(await screen.findByText("polyp")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("blood")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows an empty-state message when there are no labels", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { frame_count: 10, frame_width: 100, frame_height: 100, labels: [] },
      error: undefined,
    } as never);

    render(<SequenceStatsPanel sequenceId={9} />, { wrapper });

    expect(await screen.findByText(/no annotations yet/i)).toBeInTheDocument();
  });

  it("renders nothing before data has loaded", () => {
    vi.mocked(apiClient.GET).mockReturnValue(new Promise(() => {}) as never);

    const { container } = render(<SequenceStatsPanel sequenceId={9} />, { wrapper });

    expect(container).toBeEmptyDOMElement();
  });
});
