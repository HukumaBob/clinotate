import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../src/shared/api/client";
import { FrameAnnotationPage } from "../src/features/annotation/FrameAnnotationPage";

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/frames/42"]}>
        <Routes>
          <Route path="/frames/:frameId" element={<FrameAnnotationPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("FrameAnnotationPage", () => {
  beforeEach(() => {
    vi.spyOn(apiClient, "GET").mockImplementation((async (path: string) => {
      if (path === "/taxonomy/labels") {
        return { data: [{ id: 1, name: "Polyp", label_type: "morphological", color: "#FF0000", procedure_id: null, taxonomy_version: 1 }], error: undefined, response: new Response() };
      }
      if (path === "/annotation/frames/{frame_id}/annotations") {
        return { data: [], error: undefined, response: new Response() };
      }
      if (path === "/media/frames/{frame_id}") {
        return {
          data: {
            id: 42,
            sequence_id: 1,
            storage_key: "frames/1/000042.jpg",
            frame_index: 42,
            width: 1920,
            height: 1080,
            image_url: "https://example.test/frames/1/000042.jpg",
          },
          error: undefined,
          response: new Response(),
        };
      }
      return { data: undefined, error: "not mocked", response: new Response() };
    }) as never);

    vi.spyOn(apiClient, "POST").mockResolvedValue({
      data: { id: 100, frame_id: 42, label_id: 1, taxonomy_version: 1, annotation_type: "classification", status: "draft", created_by_id: 1, reviewed_by_id: null },
      error: undefined,
      response: new Response(),
    } as never);
  });

  it("lists available labels and creates an annotation on click", async () => {
    renderPage();

    await waitFor(() => expect(screen.getByText("Polyp")).toBeInTheDocument());

    await userEvent.click(screen.getByText("Polyp"));

    await waitFor(() => expect(apiClient.POST).toHaveBeenCalled());
  });

  it("renders the SegmentButton's frame image once the frame loads", async () => {
    renderPage();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Segment with SAM-3" })).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole("button", { name: "Segment with SAM-3" }));

    // The sidebar LabelPicker (unrelated to SegmentButton) renders its own
    // "Polyp" button with the same accessible name, so scope the click to
    // the label picker that SegmentButton itself renders below its trigger.
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Polyp" })).toHaveLength(2));
    const [segmentButtonPolypOption] = screen.getAllByRole("button", { name: "Polyp" });
    await userEvent.click(segmentButtonPolypOption);

    const image = screen.getByTestId("segment-click-target") as HTMLImageElement;
    expect(image).toBeInTheDocument();
    expect(image.src).toBe("https://example.test/frames/1/000042.jpg");
  });
});
