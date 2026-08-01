import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { TranscodePrompt } from "./TranscodePrompt";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("TranscodePrompt", () => {
  afterEach(() => vi.clearAllMocks());

  it("starts a transcode job on click and calls onTranscodeComplete exactly once when it succeeds", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 1, job_type: "video_transcode", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
    } as never);
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { id: 1, job_type: "video_transcode", status: "succeeded", progress: 100, result_ref: "videos/new.mp4", error: null, created_by_id: 1, started_at: "2026-07-29T00:00:00Z", finished_at: "2026-07-29T00:00:05Z" },
      error: undefined,
    } as never);

    const onComplete = vi.fn();
    render(<TranscodePrompt videoId={7} onTranscodeComplete={onComplete} />, { wrapper });

    await userEvent.click(screen.getByRole("button", { name: /convert video/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it("does not call onTranscodeComplete multiple times on re-render with the same succeeded status", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 1, job_type: "video_transcode", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
    } as never);
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { id: 1, job_type: "video_transcode", status: "succeeded", progress: 100, result_ref: "videos/new.mp4", error: null, created_by_id: 1, started_at: "2026-07-29T00:00:00Z", finished_at: "2026-07-29T00:00:05Z" },
      error: undefined,
    } as never);

    const onComplete = vi.fn();
    const { rerender } = render(<TranscodePrompt videoId={7} onTranscodeComplete={onComplete} />, { wrapper });

    await userEvent.click(screen.getByRole("button", { name: /convert video/i }));

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

    // Force a re-render by triggering a window focus event (simulating refetchOnWindowFocus re-resolving to the same "succeeded" data)
    fireEvent(window, new Event("focus"));

    // Wait a bit to ensure no additional effect runs
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify callback was still only called once
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("shows an indeterminate message instead of a stuck 0% when progress is -1 (duration unknown)", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 3, job_type: "video_transcode", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
    } as never);
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { id: 3, job_type: "video_transcode", status: "running", progress: -1, result_ref: null, error: null, created_by_id: 1, started_at: "2026-07-29T00:00:00Z", finished_at: null },
      error: undefined,
    } as never);

    render(<TranscodePrompt videoId={7} onTranscodeComplete={vi.fn()} />, { wrapper });

    await userEvent.click(screen.getByRole("button", { name: /convert video/i }));

    await waitFor(() => expect(screen.getByText(/converting…/i)).toBeInTheDocument());
    expect(screen.queryByText(/-1%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Converting… 0%$/)).not.toBeInTheDocument();
  });

  it("shows the error and a retry option when the job fails", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 2, job_type: "video_transcode", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
    } as never);
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: { id: 2, job_type: "video_transcode", status: "failed", progress: 0, result_ref: null, error: "ffmpeg exited with code 1", created_by_id: 1, started_at: "2026-07-29T00:00:00Z", finished_at: "2026-07-29T00:00:01Z" },
      error: undefined,
    } as never);

    render(<TranscodePrompt videoId={7} onTranscodeComplete={vi.fn()} />, { wrapper });

    await userEvent.click(screen.getByRole("button", { name: /convert video/i }));

    await waitFor(() => expect(screen.getByText(/ffmpeg exited with code 1/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /convert video/i })).toBeInTheDocument();
  });
});
