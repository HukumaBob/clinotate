import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { MediaLibraryTable } from "./MediaLibraryTable";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("MediaLibraryTable", () => {
  afterEach(() => vi.clearAllMocks());

  it("shows the backend's 409 message inline when delete is blocked by linked sequences", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        items: [
          {
            id: 1,
            kind: "video",
            filename: "a.mp4",
            title: "A Title",
            procedure_id: null,
            uploaded_at: "2026-07-28T00:00:00Z",
            last_edited_at: "2026-07-29T00:00:00Z",
            size_bytes: 1_200_000,
            linked_sequence_count: 2,
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
      },
      error: undefined,
    } as never);
    vi.mocked(apiClient.DELETE).mockResolvedValue({
      data: undefined,
      error: { detail: "Delete or reassign this video's sequences before deleting it" },
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    await screen.findByText("a.mp4");
    await userEvent.click(screen.getByRole("button", { name: /delete/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() =>
      expect(screen.getByText(/reassign this video's sequences/i)).toBeInTheDocument()
    );
  });

  it("keeps confirm state independent for a video and a photo sequence that share the same numeric id", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        items: [
          {
            id: 5,
            kind: "video",
            filename: "video-five.mp4",
            title: "Video Five",
            procedure_id: null,
            uploaded_at: "2026-07-28T00:00:00Z",
            last_edited_at: "2026-07-29T00:00:00Z",
            size_bytes: 1_000,
            linked_sequence_count: 0,
          },
          {
            id: 5,
            kind: "photo",
            filename: "photo-sequence-five",
            title: null,
            procedure_id: null,
            uploaded_at: "2026-07-27T00:00:00Z",
            last_edited_at: "2026-07-28T00:00:00Z",
            size_bytes: 2_000,
            linked_sequence_count: 1,
          },
        ],
        total: 2,
        page: 1,
        page_size: 25,
      },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    await screen.findByText("video-five.mp4");
    const deleteButtons = screen.getAllByRole("button", { name: /^delete$/i });
    expect(deleteButtons).toHaveLength(2);

    await userEvent.click(deleteButtons[0]);

    expect(screen.getByRole("button", { name: /^confirm$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
  });

  it("calls onSelectVideo with the video's id when a video row is clicked", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        items: [
          {
            id: 9,
            kind: "video",
            filename: "clickme.mp4",
            title: "Click Me Video",
            procedure_id: null,
            uploaded_at: "2026-07-28T00:00:00Z",
            last_edited_at: "2026-07-29T00:00:00Z",
            size_bytes: 1_000,
            linked_sequence_count: 0,
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
      },
      error: undefined,
    } as never);

    const onSelectVideo = vi.fn();
    render(<MediaLibraryTable onSelectVideo={onSelectVideo} />, { wrapper });

    await userEvent.click(await screen.findByText("clickme.mp4"));
    expect(onSelectVideo).toHaveBeenCalledWith(9);
  });

  it("does not call onSelectVideo when a photo row is clicked", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        items: [
          {
            id: 10,
            kind: "photo",
            filename: "batch-1",
            title: null,
            procedure_id: null,
            uploaded_at: "2026-07-28T00:00:00Z",
            last_edited_at: "2026-07-29T00:00:00Z",
            size_bytes: 1_000,
            linked_sequence_count: 1,
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
      },
      error: undefined,
    } as never);

    const onSelectVideo = vi.fn();
    render(<MediaLibraryTable onSelectVideo={onSelectVideo} />, { wrapper });

    await userEvent.click(await screen.findByText("batch-1"));
    expect(onSelectVideo).not.toHaveBeenCalled();
  });

  it("shows the video's title as the primary text with the filename as a secondary line", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        items: [
          {
            id: 20,
            kind: "video",
            filename: "raw_upload_20260101.mp4",
            title: "Colonoscopy patient 42",
            procedure_id: null,
            uploaded_at: "2026-07-28T00:00:00Z",
            last_edited_at: "2026-07-29T00:00:00Z",
            size_bytes: 1_000,
            linked_sequence_count: 0,
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
      },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText("Colonoscopy patient 42")).toBeInTheDocument();
    expect(screen.getByText("raw_upload_20260101.mp4")).toBeInTheDocument();
  });

  it("shows only the filename for a photo row, with no secondary line or null artifact", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        items: [
          {
            id: 21,
            kind: "photo",
            filename: "photo-batch-21",
            title: null,
            procedure_id: null,
            uploaded_at: "2026-07-28T00:00:00Z",
            last_edited_at: "2026-07-29T00:00:00Z",
            size_bytes: 1_000,
            linked_sequence_count: 1,
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
      },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText("photo-batch-21")).toBeInTheDocument();
    expect(screen.queryByText("null")).not.toBeInTheDocument();
    expect(screen.queryByText("undefined")).not.toBeInTheDocument();
  });

  it("shows the procedure's name instead of its raw id", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 730, name: "colono" }], error: undefined } as never;
      }
      return {
        data: {
          items: [
            {
              id: 30,
              kind: "video",
              filename: "colono_video.mp4",
              title: "Colono video",
              procedure_id: 730,
              uploaded_at: "2026-07-28T00:00:00Z",
              last_edited_at: "2026-07-29T00:00:00Z",
              size_bytes: 1_000,
              linked_sequence_count: 0,
            },
          ],
          total: 1,
          page: 1,
          page_size: 25,
        },
        error: undefined,
      } as never;
    });

    render(<MediaLibraryTable />, { wrapper });

    // "colono" also appears as an <option> in the Procedure filter select,
    // so scope the assertion to the table cell.
    expect(await screen.findByRole("cell", { name: "colono" })).toBeInTheDocument();
    expect(screen.queryByRole("cell", { name: "730" })).not.toBeInTheDocument();
  });

  it("shows the raw procedure id while procedures are still loading, and a dash when there is none", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 730, name: "colono" }], error: undefined } as never;
      }
      return {
        data: {
          items: [
            {
              id: 31,
              kind: "video",
              filename: "no_procedure.mp4",
              title: "No procedure video",
              procedure_id: null,
              uploaded_at: "2026-07-28T00:00:00Z",
              last_edited_at: "2026-07-29T00:00:00Z",
              size_bytes: 1_000,
              linked_sequence_count: 0,
            },
          ],
          total: 1,
          page: 1,
          page_size: 25,
        },
        error: undefined,
      } as never;
    });

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText("no_procedure.mp4")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows the Last edited date, distinct from Uploaded", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        items: [
          {
            id: 22,
            kind: "video",
            filename: "edited.mp4",
            title: "Edited video",
            procedure_id: null,
            uploaded_at: "2026-07-01T00:00:00Z",
            last_edited_at: "2026-07-15T00:00:00Z",
            size_bytes: 1_000,
            linked_sequence_count: 1,
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
      },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    await screen.findByText("edited.mp4");
    expect(screen.getByText(new Date("2026-07-01T00:00:00Z").toLocaleDateString())).toBeInTheDocument();
    expect(screen.getByText(new Date("2026-07-15T00:00:00Z").toLocaleDateString())).toBeInTheDocument();
  });

  it("debounces the search input before requesting", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { items: [], total: 0, page: 1, page_size: 25 },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });
    await screen.findByPlaceholderText(/search/i);

    const initialCallCount = vi.mocked(apiClient.GET).mock.calls.length;
    await userEvent.type(screen.getByPlaceholderText(/search/i), "foo");

    // No new library call fired yet -- still debouncing.
    expect(vi.mocked(apiClient.GET).mock.calls.length).toBe(initialCallCount);

    await waitFor(
      () => {
        const libraryCalls = vi
          .mocked(apiClient.GET)
          .mock.calls.filter((call) => call[0] === "/media/library");
        const lastCall = libraryCalls[libraryCalls.length - 1];
        expect(lastCall?.[1]?.params?.query?.search).toBe("foo");
      },
      { timeout: 1000 }
    );
  });

  it("sends the selected type filter as a query param", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { items: [], total: 0, page: 1, page_size: 25 },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });
    await screen.findByLabelText(/type/i);

    await userEvent.selectOptions(screen.getByLabelText(/type/i), "video");

    await waitFor(() => {
      const libraryCalls = vi
        .mocked(apiClient.GET)
        .mock.calls.filter((call) => call[0] === "/media/library");
      const lastCall = libraryCalls[libraryCalls.length - 1];
      expect(lastCall?.[1]?.params?.query?.type).toBe("video");
    });
  });

  it("toggles sort order when clicking the same column header twice", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { items: [], total: 0, page: 1, page_size: 25 },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });
    const sizeHeader = await screen.findByRole("button", { name: /size/i });

    await userEvent.click(sizeHeader);
    await waitFor(() => {
      const libraryCalls = vi
        .mocked(apiClient.GET)
        .mock.calls.filter((call) => call[0] === "/media/library");
      const lastCall = libraryCalls[libraryCalls.length - 1];
      expect(lastCall?.[1]?.params?.query?.sort).toBe("size_bytes");
      expect(lastCall?.[1]?.params?.query?.order).toBe("desc");
    });

    await userEvent.click(sizeHeader);
    await waitFor(() => {
      const libraryCalls = vi
        .mocked(apiClient.GET)
        .mock.calls.filter((call) => call[0] === "/media/library");
      const lastCall = libraryCalls[libraryCalls.length - 1];
      expect(lastCall?.[1]?.params?.query?.sort).toBe("size_bytes");
      expect(lastCall?.[1]?.params?.query?.order).toBe("asc");
    });
  });

  it("renders pagination controls driven by the response envelope", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: {
        items: [
          {
            id: 1,
            kind: "photo",
            filename: "batch-1",
            title: null,
            procedure_id: null,
            uploaded_at: "2026-07-28T00:00:00Z",
            last_edited_at: "2026-07-29T00:00:00Z",
            size_bytes: 1_000,
            linked_sequence_count: 1,
          },
        ],
        total: 60,
        page: 1,
        page_size: 25,
      },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByRole("button", { name: "2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "3" })).toBeInTheDocument();
  });

  it("shows a no-results message when the filtered list is empty", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { items: [], total: 0, page: 1, page_size: 25 },
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText(/no media matches/i)).toBeInTheDocument();
  });

  it("shows a loading indicator instead of the no-results message while the query is pending", async () => {
    let resolveLibraryFetch!: (value: unknown) => void;
    vi.mocked(apiClient.GET).mockImplementation((path) => {
      if (path === "/taxonomy/procedures") {
        return Promise.resolve({ data: [], error: undefined }) as never;
      }
      return new Promise((resolve) => {
        resolveLibraryFetch = resolve;
      }) as never;
    });

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText(/loading/i)).toBeInTheDocument();
    expect(screen.queryByText(/no media matches/i)).not.toBeInTheDocument();

    resolveLibraryFetch({
      data: { items: [], total: 0, page: 1, page_size: 25 },
      error: undefined,
    });

    expect(await screen.findByText(/no media matches/i)).toBeInTheDocument();
  });

  it("shows an error message instead of the no-results message when the query fails", async () => {
    vi.mocked(apiClient.GET).mockRejectedValue(new Error("network error"));

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText(/failed to load media library/i)).toBeInTheDocument();
    expect(screen.queryByText(/no media matches/i)).not.toBeInTheDocument();
  });

  it("clamps back to the last valid page when the item count shrinks below the current page after a delete", async () => {
    function makeItem(id: number) {
      return {
        id,
        kind: "photo" as const,
        filename: `batch-${id}`,
        title: null,
        procedure_id: null,
        uploaded_at: "2026-07-28T00:00:00Z",
        last_edited_at: "2026-07-29T00:00:00Z",
        size_bytes: 1_000,
        linked_sequence_count: 0,
      };
    }

    // Page 1: 60 total items -> pages 1, 2, 3 available.
    vi.mocked(apiClient.GET).mockImplementation(async (path, options) => {
      if (path === "/taxonomy/procedures") {
        return { data: [], error: undefined } as never;
      }
      const requestedPage = (options as { params?: { query?: { page?: number } } })?.params?.query
        ?.page;
      if (requestedPage === 3) {
        // After deleting the sole item on page 3, only 2 pages remain.
        return {
          data: { items: [], total: 50, page: 3, page_size: 25 },
          error: undefined,
        } as never;
      }
      return {
        data: { items: [makeItem(requestedPage ?? 1)], total: 60, page: requestedPage ?? 1, page_size: 25 },
        error: undefined,
      } as never;
    });

    render(<MediaLibraryTable />, { wrapper });

    await screen.findByRole("button", { name: "3" });
    await userEvent.click(screen.getByRole("button", { name: "3" }));

    // Page 3 request resolves with total shrunk to 50 (2 pages) -- page should clamp to 2.
    await waitFor(() => {
      const libraryCalls = vi
        .mocked(apiClient.GET)
        .mock.calls.filter((call) => call[0] === "/media/library");
      const lastCall = libraryCalls[libraryCalls.length - 1];
      expect(lastCall?.[1]?.params?.query?.page).toBe(2);
    });
  });
});
