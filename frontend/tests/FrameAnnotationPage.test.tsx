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
});
