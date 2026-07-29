import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { VideoReviewPlayer } from "./VideoReviewPlayer";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("VideoReviewPlayer", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders the native player when the video is browser-playable", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/media/videos/{video_id}") {
        return {
          data: {
            id: 5, filename: "a.mp4", title: "A", procedure_id: 1, fps: 1,
            duration_seconds: 60, size_bytes: 100,
            browser_playable: true, container: "mov,mp4,m4a,3gp,3g2,mj2", video_codec: "h264",
            stream_url: "https://minio.local/videos/a.mp4?signed=1",
          },
          error: undefined,
        } as never;
      }
      if (path === "/media/videos/{video_id}/sequences") {
        return { data: [], error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });

    render(<VideoReviewPlayer videoId={5} onBack={vi.fn()} onOpenSequence={vi.fn()} />, { wrapper });

    await waitFor(() => expect(document.querySelector("video")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /convert video/i })).not.toBeInTheDocument();
  });

  it("renders TranscodePrompt instead of the player when not browser-playable", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/media/videos/{video_id}") {
        return {
          data: {
            id: 6, filename: "b.mp4", title: "B", procedure_id: 1, fps: 1,
            duration_seconds: 60, size_bytes: 100,
            browser_playable: false, container: "mov,mp4,m4a,3gp,3g2,mj2", video_codec: "mpeg4",
            stream_url: "https://minio.local/videos/b.mp4?signed=1",
          },
          error: undefined,
        } as never;
      }
      if (path === "/media/videos/{video_id}/sequences") {
        return { data: [], error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });

    render(<VideoReviewPlayer videoId={6} onBack={vi.fn()} onOpenSequence={vi.fn()} />, { wrapper });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /convert video/i })).toBeInTheDocument()
    );
    expect(document.querySelector("video")).not.toBeInTheDocument();
  });

  it("calls onBack when the back button is clicked", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/media/videos/{video_id}") {
        return {
          data: {
            id: 5, filename: "a.mp4", title: "A", procedure_id: 1, fps: 1,
            duration_seconds: 60, size_bytes: 100,
            browser_playable: true, container: "mov,mp4,m4a,3gp,3g2,mj2", video_codec: "h264",
          },
          error: undefined,
        } as never;
      }
      return { data: [], error: undefined } as never;
    });

    const onBack = vi.fn();
    render(<VideoReviewPlayer videoId={5} onBack={onBack} onOpenSequence={vi.fn()} />, { wrapper });

    await userEvent.click(await screen.findByRole("button", { name: /upload another video/i }));
    expect(onBack).toHaveBeenCalled();
  });
});
