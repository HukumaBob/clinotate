import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { SequenceGridPage } from "../src/features/annotation/SequenceGridPage";

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/videos/1/sequences/9"]}>
        <Routes>
          <Route path="/videos/:videoId/sequences/:sequenceId" element={<SequenceGridPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SequenceGridPage", () => {
  beforeEach(() => {
    vi.spyOn(apiClient, "GET").mockImplementation((async (path: string, options: never) => {
      if (path === "/media/sequences/{sequence_id}/frames") {
        return {
          data: [
            { id: 101, sequence_id: 9, storage_key: "frames/9/0.png", frame_index: 0, width: 100, height: 100, image_url: "https://example.test/f0.png" },
            { id: 102, sequence_id: 9, storage_key: "frames/9/1.png", frame_index: 1, width: 100, height: 100, image_url: "https://example.test/f1.png" },
          ],
          error: undefined,
          response: new Response(),
        };
      }
      if (path === "/annotation/frames/{frame_id}/annotations") {
        return { data: [], error: undefined, response: new Response() };
      }
      if (path === "/media/frames/{frame_id}") {
        return {
          data: { id: 101, sequence_id: 9, storage_key: "frames/9/0.png", frame_index: 0, width: 100, height: 100, image_url: "https://example.test/f0.png" },
          error: undefined,
          response: new Response(),
        };
      }
      if (path === "/taxonomy/labels/tree") {
        return { data: [], error: undefined, response: new Response() };
      }
      return { data: undefined, error: "not mocked", response: new Response() };
    }) as never);
  });

  it("renders one thumbnail per frame in the sequence", async () => {
    renderPage();

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
  });

  it("swaps the grid for the frame editor when a thumbnail is clicked", async () => {
    renderPage();

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    await userEvent.click(screen.getAllByRole("img")[0]);

    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());
  });

  it("returns to the grid when Back to grid is clicked", async () => {
    renderPage();

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
    await userEvent.click(screen.getAllByRole("img")[0]);
    await waitFor(() => expect(screen.getByTestId("frame-canvas")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /back to grid/i }));

    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
  });
});
