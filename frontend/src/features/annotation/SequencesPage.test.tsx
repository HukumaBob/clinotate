import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

const navigateMock = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

import { apiClient } from "../../shared/api/client";
import { SequencesPage } from "./SequencesPage";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function mockGetImplementation() {
  return async (path: string) => {
    if (path === "/media/sequences/stats") {
      return {
        data: { total_sequences: 2, total_frames: 60, labeled_sequences: 1, unlabeled_sequences: 1 },
        error: undefined,
      };
    }
    if (path === "/media/sequences") {
      return {
        data: {
          items: [
            {
              id: 1,
              name: "seq-one",
              video_id: null,
              procedure_id: 1,
              frame_count: 40,
              labeled_frame_count: 40,
              preview_frames: [],
            },
            {
              id: 2,
              name: "seq-two",
              video_id: null,
              procedure_id: 1,
              frame_count: 20,
              labeled_frame_count: 0,
              preview_frames: [],
            },
          ],
          total: 2,
          page: 1,
          page_size: 25,
        },
        error: undefined,
      };
    }
    if (path === "/taxonomy/procedures") {
      return { data: [{ id: 1, name: "Colonoscopy" }], error: undefined };
    }
    if (path === "/media/videos") {
      return { data: [], error: undefined };
    }
    return { data: [], error: undefined };
  };
}

describe("SequencesPage", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders the aggregate stats and a card per sequence", async () => {
    vi.mocked(apiClient.GET).mockImplementation(mockGetImplementation() as never);

    render(<SequencesPage />, { wrapper });

    await waitFor(() => expect(screen.getByText("seq-one")).toBeInTheDocument());
    expect(screen.getByText("seq-two")).toBeInTheDocument();

    expect(screen.getByText("2")).toBeInTheDocument(); // total_sequences
    expect(screen.getByText("60")).toBeInTheDocument(); // total_frames
  });

  it("navigates to the sequence grid when Annotate is clicked", async () => {
    vi.mocked(apiClient.GET).mockImplementation(mockGetImplementation() as never);

    render(<SequencesPage />, { wrapper });

    await waitFor(() => expect(screen.getByText("seq-one")).toBeInTheDocument());
    screen.getAllByRole("button", { name: "Annotate" })[0].click();

    expect(navigateMock).toHaveBeenCalledWith("/sequences/1");
  });
});
