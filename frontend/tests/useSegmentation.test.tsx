import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { apiClient } from "../src/shared/api/client";
import { useSam2Predict, useSam2Track } from "../src/entities/useSegmentation";

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("useSam2Predict", () => {
  it("posts to /jobs/sam2/predict with frame_id, label_id, prompts", async () => {
    vi.spyOn(apiClient, "POST").mockResolvedValue({
      data: { id: 1, job_type: "sam2_predict", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useSam2Predict(), { wrapper });
    result.current.mutate({ frame_id: 42, label_id: 5, prompts: [{ type: "point", coords: [0.5, 0.5], label: true }] });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.POST).toHaveBeenCalledWith(
      "/jobs/sam2/predict",
      expect.objectContaining({ body: { frame_id: 42, label_id: 5, prompts: [{ type: "point", coords: [0.5, 0.5], label: true }] } }),
    );
  });
});

describe("useSam2Track", () => {
  it("posts to /jobs/sam2/track with anchor_frame_id, backward, forward", async () => {
    vi.spyOn(apiClient, "POST").mockResolvedValue({
      data: { id: 2, job_type: "sam2_track", status: "pending", progress: 0, result_ref: null, error: null, created_by_id: 1, started_at: null, finished_at: null },
      error: undefined,
      response: new Response(),
    } as never);

    const { result } = renderHook(() => useSam2Track(), { wrapper });
    result.current.mutate({
      sequence_id: 9,
      label_id: 5,
      prompts: [{ type: "point", coords: [0.5, 0.5], label: true }],
      anchor_frame_id: 42,
      backward: 5,
      forward: 5,
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.POST).toHaveBeenCalledWith(
      "/jobs/sam2/track",
      expect.objectContaining({
        body: { sequence_id: 9, label_id: 5, prompts: [{ type: "point", coords: [0.5, 0.5], label: true }], anchor_frame_id: 42, backward: 5, forward: 5 },
      }),
    );
  });
});
