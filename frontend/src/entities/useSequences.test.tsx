import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../shared/api/client";
import { useCreatePhotoSequence, useCreateSequenceFromVideo } from "./useSequences";

vi.mock("../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useCreateSequenceFromVideo", () => {
  afterEach(() => vi.clearAllMocks());

  it("posts name, start/duration/fps, and crop to the video's sequences endpoint", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { id: 9 }, error: undefined } as never);
    const { result } = renderHook(() => useCreateSequenceFromVideo(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        videoId: 4,
        name: "My seq",
        startTime: 0,
        duration: 10,
        fps: 2,
        crop: { left: 5, right: 5, top: 0, bottom: 0 },
      });
    });

    expect(apiClient.POST).toHaveBeenCalledWith("/media/videos/{video_id}/sequences", {
      params: { path: { video_id: 4 } },
      body: {
        name: "My seq",
        start_time: 0,
        duration: 10,
        fps: 2,
        crop: { left: 5, right: 5, top: 0, bottom: 0 },
      },
    });
  });
});

describe("useCreatePhotoSequence", () => {
  afterEach(() => vi.clearAllMocks());

  it("posts all files, name, and procedureId as multipart form data", async () => {
    vi.mocked(apiClient.POST).mockResolvedValue({ data: { id: 11 }, error: undefined } as never);
    const { result } = renderHook(() => useCreatePhotoSequence(), { wrapper });

    const files = [new File(["a"], "a.png", { type: "image/png" })];
    await act(async () => {
      await result.current.mutateAsync({ files, name: "Photo seq", procedureId: 2 });
    });

    const call = vi.mocked(apiClient.POST).mock.calls[0];
    const formData = call[1]?.body as FormData;
    expect(formData.get("name")).toBe("Photo seq");
    expect(formData.get("procedure_id")).toBe("2");
    expect(formData.getAll("files").length).toBe(1);
  });
});
