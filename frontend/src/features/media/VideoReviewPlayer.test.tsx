import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { VideoReviewPlayer } from "./VideoReviewPlayer";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("VideoReviewPlayer", () => {
  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

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

  it("pre-fills marks from the clicked segment and PATCHes on re-cut confirm", async () => {
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
        return {
          data: [
            { id: 1, name: "Larynx", video_id: 5, procedure_id: 1, start_time: 10, duration: 20, annotation_count: 2, crop_box: null },
          ],
          error: undefined,
        } as never;
      }
      return { data: undefined, error: undefined } as never;
    });
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { id: 1, name: "Larynx", video_id: 5, procedure_id: 1, start_time: 10, duration: 20, annotation_count: 2 },
      error: undefined,
    } as never);

    render(<VideoReviewPlayer videoId={5} onBack={vi.fn()} onOpenSequence={vi.fn()} />, { wrapper });

    fireEvent.mouseDown(await screen.findByTitle("Larynx"));
    expect(await screen.findByText(/10s – 30s/)).toBeInTheDocument();

    const fpsInput = screen.getByLabelText(/fps/i);
    await userEvent.type(fpsInput, "3");
    // Nudge the crop so the range/crop comparison flags this as a re-cut
    // (SequenceForm only asks for confirmation when range or crop changed;
    // fps alone never does, since there's no "previous fps" to compare to).
    await userEvent.type(screen.getByLabelText(/left %/i), "5");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /confirm/i }));

    await waitFor(() =>
      expect(apiClient.PATCH).toHaveBeenCalledWith(
        "/media/sequences/{sequence_id}",
        expect.objectContaining({
          params: { path: { sequence_id: 1 } },
          body: expect.objectContaining({ start_time: 10, duration: 20, fps: 3 }),
        })
      )
    );
  });

  it("renders Mark start/Mark end buttons itself, not inside the timeline row", async () => {
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

    expect(await screen.findByRole("button", { name: /mark start/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark end/i })).toBeInTheDocument();
  });

  it("wires sequencesQuery data into SequenceForm's create mode so it inherits a real fetched crop_box", async () => {
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
        return {
          data: [
            {
              id: 1, name: "Larynx", video_id: 5, procedure_id: 1,
              start_time: 0, duration: 10, annotation_count: 0,
              crop_box: { left: 15, right: 0, top: 0, bottom: 0 },
            },
          ],
          error: undefined,
        } as never;
      }
      if (path === "/taxonomy/procedures") {
        return { data: [{ id: 1, name: "EGD" }], error: undefined } as never;
      }
      if (path === "/media/sequences/suggest-name") {
        return { data: { name: "EGD 2026-07-30 #1" }, error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });

    render(<VideoReviewPlayer videoId={5} onBack={vi.fn()} onOpenSequence={vi.fn()} />, { wrapper });

    const video = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).toBeInTheDocument();
      return el as HTMLVideoElement;
    });

    // jsdom's video element always reports currentTime 0 and never fires
    // loadedmetadata; stub/dispatch both so "Mark start" / "Mark end" are
    // enabled and produce two distinct mark points.
    let currentTime = 20;
    Object.defineProperty(video, "currentTime", { get: () => currentTime, configurable: true });
    fireEvent.loadedMetadata(video);

    await userEvent.click(await screen.findByRole("button", { name: /mark start/i }));
    currentTime = 40;
    await userEvent.click(screen.getByRole("button", { name: /mark end/i }));

    expect(await screen.findByLabelText(/left %/i)).toHaveValue(15);
  });

  describe("QC sequences", () => {
    function mockWithQcSequence() {
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
          return {
            data: [
              {
                id: 1, name: "Larynx", video_id: 5, procedure_id: 1,
                start_time: 0, duration: 10, annotation_count: 0,
                crop_box: { left: 15, right: 0, top: 0, bottom: 0 },
                origin_qc_run_id: null,
              },
              {
                id: 2, name: "QC sequence", video_id: 5, procedure_id: 1,
                start_time: 2, duration: 50, annotation_count: 0,
                crop_box: null, origin_qc_run_id: 9,
              },
            ],
            error: undefined,
          } as never;
        }
        if (path === "/taxonomy/procedures") {
          return { data: [{ id: 1, name: "EGD" }], error: undefined } as never;
        }
        if (path === "/media/sequences/suggest-name") {
          return { data: { name: "EGD 2026-07-30 #1" }, error: undefined } as never;
        }
        return { data: undefined, error: undefined } as never;
      });
    }

    it("does not draw QC sequences on the timeline", async () => {
      mockWithQcSequence();
      render(<VideoReviewPlayer videoId={5} onBack={vi.fn()} onOpenSequence={vi.fn()} />, { wrapper });

      expect(await screen.findByTitle("Larynx")).toBeInTheDocument();
      expect(screen.queryByTitle("QC sequence")).not.toBeInTheDocument();
    });

    it("ignores QC sequences when inheriting the crop for a new sequence", async () => {
      mockWithQcSequence();
      render(<VideoReviewPlayer videoId={5} onBack={vi.fn()} onOpenSequence={vi.fn()} />, { wrapper });

      const video = await waitFor(() => {
        const el = document.querySelector("video");
        expect(el).toBeInTheDocument();
        return el as HTMLVideoElement;
      });
      let currentTime = 20;
      Object.defineProperty(video, "currentTime", { get: () => currentTime, configurable: true });
      fireEvent.loadedMetadata(video);
      await userEvent.click(await screen.findByRole("button", { name: /mark start/i }));
      currentTime = 40;
      await userEvent.click(screen.getByRole("button", { name: /mark end/i }));

      // The QC sequence has the highest id and no crop; the regular crop must still win.
      expect(await screen.findByLabelText(/left %/i)).toHaveValue(15);
    });
  });

  it("shows the marked timestamp next to Mark start/Mark end after clicking, and persists marks across a remount for the same video", async () => {
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

    const { unmount } = render(
      <VideoReviewPlayer videoId={5} onBack={vi.fn()} onOpenSequence={vi.fn()} />,
      { wrapper }
    );

    const video = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).toBeInTheDocument();
      return el as HTMLVideoElement;
    });

    let currentTime = 135;
    Object.defineProperty(video, "currentTime", { get: () => currentTime, configurable: true });
    fireEvent.loadedMetadata(video);

    await userEvent.click(screen.getByRole("button", { name: /mark start/i }));
    expect(await screen.findByText("02:15")).toBeInTheDocument();

    currentTime = 200;
    await userEvent.click(screen.getByRole("button", { name: /mark end/i }));
    expect(await screen.findByText("03:20")).toBeInTheDocument();

    unmount();

    render(<VideoReviewPlayer videoId={5} onBack={vi.fn()} onOpenSequence={vi.fn()} />, { wrapper });

    expect(await screen.findByText("02:15")).toBeInTheDocument();
    expect(await screen.findByText("03:20")).toBeInTheDocument();
  });

  it("does not restore marks from a different video's storage", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/media/videos/{video_id}") {
        return {
          data: {
            id: 7, filename: "c.mp4", title: "C", procedure_id: 1, fps: 1,
            duration_seconds: 60, size_bytes: 100,
            browser_playable: true, container: "mov,mp4,m4a,3gp,3g2,mj2", video_codec: "h264",
            stream_url: "https://minio.local/videos/c.mp4?signed=1",
          },
          error: undefined,
        } as never;
      }
      if (path === "/media/videos/{video_id}/sequences") {
        return { data: [], error: undefined } as never;
      }
      return { data: undefined, error: undefined } as never;
    });

    localStorage.setItem("video-marks-5", JSON.stringify({ markStart: 15, markEnd: 30 }));

    render(<VideoReviewPlayer videoId={7} onBack={vi.fn()} onOpenSequence={vi.fn()} />, { wrapper });

    await waitFor(() => expect(document.querySelector("video")).toBeInTheDocument());
    expect(screen.queryByText("00:15")).not.toBeInTheDocument();
  });

  it("scrubs the video's currentTime when the timeline reports a scrub position", async () => {
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

    const video = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).toBeInTheDocument();
      return el as HTMLVideoElement;
    });
    fireEvent.loadedMetadata(video);

    let currentTimeSetTo: number | null = null;
    Object.defineProperty(video, "currentTime", {
      get: () => 0,
      set: (value: number) => { currentTimeSetTo = value; },
      configurable: true,
    });

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });

    // The timeline is the only element with class "relative h-10 w-full rounded bg-gray-800".
    const timelineRoot = document.querySelector(".relative.h-10.w-full.rounded.bg-gray-800") as HTMLElement;
    fireEvent.mouseDown(timelineRoot, { clientX: 40, target: timelineRoot, currentTarget: timelineRoot });
    fireEvent.mouseMove(window, { clientX: 100 });
    fireEvent.mouseUp(window);

    expect(currentTimeSetTo).toBe(30);
  });

  it("seeks the video to a segment's start time when the segment is clicked", async () => {
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
        return {
          data: [
            { id: 2, video_id: 5, name: "Esophagus", start_time: 20, duration: 30, fps: 1, procedure_id: 1 },
          ],
          error: undefined,
        } as never;
      }
      return { data: undefined, error: undefined } as never;
    });

    render(<VideoReviewPlayer videoId={5} onBack={vi.fn()} onOpenSequence={vi.fn()} />, { wrapper });

    const video = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).toBeInTheDocument();
      return el as HTMLVideoElement;
    });
    fireEvent.loadedMetadata(video);

    let currentTimeSetTo: number | null = null;
    Object.defineProperty(video, "currentTime", {
      get: () => 0,
      set: (value: number) => { currentTimeSetTo = value; },
      configurable: true,
    });

    fireEvent.mouseDown(screen.getByText("Esophagus"), { clientX: 100 });
    fireEvent.mouseUp(window, { clientX: 100 });

    expect(currentTimeSetTo).toBe(20);
  });

  it("seeks the video to the start of the clicked gap when empty timeline background is clicked", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path) => {
      if (path === "/media/videos/{video_id}") {
        return {
          data: {
            id: 5, filename: "a.mp4", title: "A", procedure_id: 1, fps: 1,
            duration_seconds: 100, size_bytes: 100,
            browser_playable: true, container: "mov,mp4,m4a,3gp,3g2,mj2", video_codec: "h264",
            stream_url: "https://minio.local/videos/a.mp4?signed=1",
          },
          error: undefined,
        } as never;
      }
      if (path === "/media/videos/{video_id}/sequences") {
        return {
          data: [
            { id: 2, video_id: 5, name: "Esophagus", start_time: 20, duration: 30, fps: 1, procedure_id: 1 },
          ],
          error: undefined,
        } as never;
      }
      return { data: undefined, error: undefined } as never;
    });

    render(<VideoReviewPlayer videoId={5} onBack={vi.fn()} onOpenSequence={vi.fn()} />, { wrapper });

    const video = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).toBeInTheDocument();
      return el as HTMLVideoElement;
    });
    fireEvent.loadedMetadata(video);

    let currentTimeSetTo: number | null = null;
    Object.defineProperty(video, "currentTime", {
      get: () => 0,
      set: (value: number) => { currentTimeSetTo = value; },
      configurable: true,
    });

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 40, width: 200, height: 40, x: 0, y: 0, toJSON: () => {},
    });

    // durationSeconds=100 -> 2px/s. Esophagus [20,50). Click past it at clientX=140 -> 70s,
    // gap bounds: left=50 (Esophagus's end), right=100 (duration, no next segment).
    const timelineRoot = document.querySelector(".relative.h-10.w-full.rounded.bg-gray-800") as HTMLElement;
    fireEvent.mouseDown(timelineRoot, { clientX: 140, target: timelineRoot, currentTarget: timelineRoot });
    fireEvent.mouseUp(window, { clientX: 140 });

    expect(currentTimeSetTo).toBe(50);
  });

  it("shows native player controls only while the cursor hovers the video, so the scrubber doesn't obscure the crop overlay by default", async () => {
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

    const video = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).toBeInTheDocument();
      return el as HTMLVideoElement;
    });

    expect(video).not.toHaveAttribute("controls");

    const container = video.parentElement as HTMLElement;
    fireEvent.mouseEnter(container);
    expect(video).toHaveAttribute("controls");

    fireEvent.mouseLeave(container);
    expect(video).not.toHaveAttribute("controls");
  });

  it("passes onOpenSequence through to the edit-mode SequenceForm as onOpenEditor, not to the timeline", async () => {
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
        return {
          data: [
            { id: 1, name: "Larynx", video_id: 5, procedure_id: 1, start_time: 10, duration: 20, annotation_count: 2, crop_box: null },
          ],
          error: undefined,
        } as never;
      }
      return { data: undefined, error: undefined } as never;
    });

    const onOpenSequence = vi.fn();
    render(
      <VideoReviewPlayer videoId={5} onBack={vi.fn()} onOpenSequence={onOpenSequence} />,
      { wrapper }
    );

    fireEvent.mouseDown(await screen.findByTitle("Larynx"));
    expect(await screen.findByText(/10s – 30s/)).toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: /open in editor/i }));

    expect(onOpenSequence).toHaveBeenCalledWith(1);
  });
});
