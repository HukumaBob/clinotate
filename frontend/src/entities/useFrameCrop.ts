import { useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { Crop } from "../features/media/CropFields";

function unwrap<T>(result: { data?: T; error?: unknown }): T {
  if (result.data === undefined) {
    const detail = (result.error as { detail?: unknown } | undefined)?.detail;
    throw new Error(typeof detail === "string" ? detail : "Request failed");
  }
  return result.data;
}

export type CropFramesParams = {
  sequenceId: number;
  frameIds: number[];
  crop: Crop;
  dryRun: boolean;
};

/** Cuts the frames (and their masks) to the crop; `dryRun` only counts. */
export function useCropFrames() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sequenceId, frameIds, crop, dryRun }: CropFramesParams) =>
      unwrap(
        await apiClient.POST("/media/sequences/{sequence_id}/frames/crop", {
          params: { path: { sequence_id: sequenceId } },
          body: { frame_ids: frameIds, crop, dry_run: dryRun },
        }),
      ),
    onSuccess: (_data, variables) => {
      if (variables.dryRun) return;
      for (const frameId of variables.frameIds) {
        queryClient.invalidateQueries({ queryKey: ["annotations", frameId] });
        queryClient.invalidateQueries({ queryKey: ["frame", frameId] });
      }
      queryClient.invalidateQueries({ queryKey: ["frames", variables.sequenceId] });
    },
  });
}

/** Proposes a crop from the border of the given frames; `crop` is null when there is none to find. */
export function useDetectFramesCrop() {
  return useMutation({
    mutationFn: async ({ sequenceId, frameIds }: { sequenceId: number; frameIds: number[] }) =>
      unwrap(
        await apiClient.POST("/media/sequences/{sequence_id}/frames/detect-crop", {
          params: { path: { sequence_id: sequenceId } },
          body: { frame_ids: frameIds },
        }),
      ),
  });
}
