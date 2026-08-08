import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { SequenceGridPage } from "./SequenceGridPage";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderAtSequence(sequenceId: string) {
  return render(
    <MemoryRouter initialEntries={[`/sequences/${sequenceId}`]}>
      <Routes>
        <Route path="/sequences/:sequenceId" element={<SequenceGridPage />} />
      </Routes>
    </MemoryRouter>,
    { wrapper },
  );
}

describe("SequenceGridPage", () => {
  afterEach(() => vi.clearAllMocks());

  it("fetches the taxonomy tree using the sequence's procedure_id and resolves thumbnail labels", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/media/sequences/{sequence_id}") {
        return {
          data: {
            id: 9,
            name: "Seq",
            video_id: null,
            procedure_id: 7,
            start_time: 0,
            duration: 0,
            annotation_count: 1,
            crop_box: null,
          },
          error: undefined,
        } as never;
      }
      if (path === "/annotation/frames/{frame_id}/annotations") {
        return {
          data: [
            {
              id: 1,
              frame_id: 1,
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
        } as never;
      }
      if (path === "/media/videos/{video_id}/sequences" || path.includes("/frames")) {
        return { data: [{ id: 1, sequence_id: 9, storage_key: "k", frame_index: 0, width: 10, height: 10, image_url: "http://x/f.png" }], error: undefined } as never;
      }
      if (path === "/taxonomy/tree") {
        return {
          data: [
            {
              category: { id: 1, name: "Polyp", procedure_id: 7 },
              evaluation_types: [
                {
                  evaluation_type: { id: 10, name: "Morphology" },
                  labels: [{ id: 100, name: "Sessile", color: "#ff0000", category_id: 1 }],
                },
              ],
            },
          ],
          error: undefined,
        } as never;
      }
      return { data: [], error: undefined } as never;
    });

    renderAtSequence("9");

    expect(await screen.findByText("Polyp / Sessile")).toBeInTheDocument();
    expect(apiClient.GET).toHaveBeenCalledWith(
      "/taxonomy/tree",
      expect.objectContaining({ params: { query: { procedure_id: 7 } } }),
    );
  });

  it("selecting frames and confirming delete calls the bulk-delete mutation with the checked frame ids", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/media/sequences/{sequence_id}") {
        return {
          data: {
            id: 9,
            name: "Seq",
            video_id: null,
            procedure_id: 7,
            start_time: 0,
            duration: 0,
            annotation_count: 0,
            crop_box: null,
          },
          error: undefined,
        } as never;
      }
      if (path === "/annotation/frames/{frame_id}/annotations") {
        return { data: [], error: undefined } as never;
      }
      if (path.includes("/frames")) {
        return {
          data: [
            { id: 1, sequence_id: 9, storage_key: "k1", frame_index: 0, width: 10, height: 10, image_url: "http://x/1.png" },
            { id: 2, sequence_id: 9, storage_key: "k2", frame_index: 1, width: 10, height: 10, image_url: "http://x/2.png" },
          ],
          error: undefined,
        } as never;
      }
      if (path === "/taxonomy/tree") {
        return { data: [], error: undefined } as never;
      }
      return { data: [], error: undefined } as never;
    });
    vi.mocked(apiClient.DELETE).mockResolvedValue({
      data: { deleted_ids: [1, 2] },
      error: undefined,
    } as never);

    renderAtSequence("9");

    fireEvent.click(screen.getByRole("button", { name: /select/i }));

    const images = await screen.findAllByAltText(/Frame \d/);
    images.forEach((img) => fireEvent.click(img.closest("button")!));

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/media/sequences/{sequence_id}/frames",
      expect.objectContaining({
        params: { path: { sequence_id: 9 } },
        body: { frame_ids: [1, 2] },
      }),
    );
  });

  it("shows the sequence name in the toolbar instead of a numeric id placeholder", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/media/sequences/{sequence_id}") {
        return {
          data: {
            id: 9,
            name: "Colonoscopy run 4",
            video_id: null,
            procedure_id: 7,
            start_time: 0,
            duration: 0,
            annotation_count: 0,
            crop_box: null,
          },
          error: undefined,
        } as never;
      }
      return { data: [], error: undefined } as never;
    });

    renderAtSequence("9");

    expect(await screen.findByText("Colonoscopy run 4")).toBeInTheDocument();
    expect(screen.queryByText(/Sequence #9/)).not.toBeInTheDocument();
  });
});
