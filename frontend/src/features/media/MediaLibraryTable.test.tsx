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
      data: [
        {
          id: 1,
          kind: "video",
          filename: "a.mp4",
          title: "A Title",
          procedure_id: null,
          uploaded_at: "2026-07-28T00:00:00Z",
          size_bytes: 1_200_000,
          linked_sequence_count: 2,
        },
      ],
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
      data: [
        {
          id: 5,
          kind: "video",
          filename: "video-five.mp4",
          title: "Video Five",
          procedure_id: null,
          uploaded_at: "2026-07-28T00:00:00Z",
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
          size_bytes: 2_000,
          linked_sequence_count: 1,
        },
      ],
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
      data: [
        {
          id: 9,
          kind: "video",
          filename: "clickme.mp4",
          title: "Click Me Video",
          procedure_id: null,
          uploaded_at: "2026-07-28T00:00:00Z",
          size_bytes: 1_000,
          linked_sequence_count: 0,
        },
      ],
      error: undefined,
    } as never);

    const onSelectVideo = vi.fn();
    render(<MediaLibraryTable onSelectVideo={onSelectVideo} />, { wrapper });

    await userEvent.click(await screen.findByText("clickme.mp4"));
    expect(onSelectVideo).toHaveBeenCalledWith(9);
  });

  it("does not call onSelectVideo when a photo row is clicked", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 10,
          kind: "photo",
          filename: "batch-1",
          title: null,
          procedure_id: null,
          uploaded_at: "2026-07-28T00:00:00Z",
          size_bytes: 1_000,
          linked_sequence_count: 1,
        },
      ],
      error: undefined,
    } as never);

    const onSelectVideo = vi.fn();
    render(<MediaLibraryTable onSelectVideo={onSelectVideo} />, { wrapper });

    await userEvent.click(await screen.findByText("batch-1"));
    expect(onSelectVideo).not.toHaveBeenCalled();
  });

  it("shows the video's title as the primary text with the filename as a secondary line", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 20,
          kind: "video",
          filename: "raw_upload_20260101.mp4",
          title: "Colonoscopy patient 42",
          procedure_id: null,
          uploaded_at: "2026-07-28T00:00:00Z",
          size_bytes: 1_000,
          linked_sequence_count: 0,
        },
      ],
      error: undefined,
    } as never);

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText("Colonoscopy patient 42")).toBeInTheDocument();
    expect(screen.getByText("raw_upload_20260101.mp4")).toBeInTheDocument();
  });

  it("shows only the filename for a photo row, with no secondary line or null artifact", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 21,
          kind: "photo",
          filename: "photo-batch-21",
          title: null,
          procedure_id: null,
          uploaded_at: "2026-07-28T00:00:00Z",
          size_bytes: 1_000,
          linked_sequence_count: 1,
        },
      ],
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
        data: [
          {
            id: 30,
            kind: "video",
            filename: "colono_video.mp4",
            title: "Colono video",
            procedure_id: 730,
            uploaded_at: "2026-07-28T00:00:00Z",
            size_bytes: 1_000,
            linked_sequence_count: 0,
          },
        ],
        error: undefined,
      } as never;
    });

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText("colono")).toBeInTheDocument();
    expect(screen.queryByText("730")).not.toBeInTheDocument();
  });

  it("shows the raw procedure id while procedures are still loading, and a dash when there is none", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 730, name: "colono" }], error: undefined } as never;
      }
      return {
        data: [
          {
            id: 31,
            kind: "video",
            filename: "no_procedure.mp4",
            title: "No procedure video",
            procedure_id: null,
            uploaded_at: "2026-07-28T00:00:00Z",
            size_bytes: 1_000,
            linked_sequence_count: 0,
          },
        ],
        error: undefined,
      } as never;
    });

    render(<MediaLibraryTable />, { wrapper });

    expect(await screen.findByText("no_procedure.mp4")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
