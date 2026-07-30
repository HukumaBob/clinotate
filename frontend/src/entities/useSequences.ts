import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useVideoSequences(videoId: number | null) {
  return useQuery({
    queryKey: ["video-sequences", videoId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/videos/{video_id}/sequences", {
        params: { path: { video_id: videoId as number } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    enabled: videoId !== null,
  });
}

export function useSequencesForVideo(videoId: number) {
  return useQuery({
    queryKey: ["sequences", "video", videoId],
    queryFn: async () => {
      const result = await apiClient.GET("/media/videos/{video_id}/sequences", {
        params: { path: { video_id: videoId } },
      });
      return result.data ?? [];
    },
    enabled: Number.isFinite(videoId),
  });
}

export function useCreateStandaloneSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ procedureId, name }: { procedureId: number; name: string }) => {
      const result = await apiClient.POST("/media/sequences", {
        body: { procedure_id: procedureId, name, start_time: 0, duration: 0 },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sequences"] });
    },
  });
}

export function useCreateSequenceFromVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      videoId: number;
      name: string;
      procedureId?: number;
      startTime: number;
      duration: number;
      fps: number;
      crop?: { left: number; right: number; top: number; bottom: number };
    }) => {
      const result = await apiClient.POST("/media/videos/{video_id}/sequences", {
        params: { path: { video_id: params.videoId } },
        body: {
          name: params.name,
          procedure_id: params.procedureId,
          start_time: params.startTime,
          duration: params.duration,
          fps: params.fps,
          crop: params.crop,
        },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sequences"] });
      queryClient.invalidateQueries({ queryKey: ["media-library"] });
    },
  });
}

export function useCreatePhotoSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      files,
      name,
      procedureId,
    }: {
      files: File[];
      name: string;
      procedureId: number;
    }) => {
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      formData.append("name", name);
      formData.append("procedure_id", String(procedureId));
      const result = await apiClient.POST("/media/sequences/photos", {
        body: formData as never,
        bodySerializer: (body) => body as unknown as FormData,
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sequences"] });
      queryClient.invalidateQueries({ queryKey: ["media-library"] });
    },
  });
}

export function useUpdateSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      sequenceId: number;
      name?: string;
      procedureId?: number;
      startTime?: number;
      duration?: number;
      fps?: number;
      crop?: { left: number; right: number; top: number; bottom: number };
    }) => {
      const result = await apiClient.PATCH("/media/sequences/{sequence_id}", {
        params: { path: { sequence_id: params.sequenceId } },
        body: {
          name: params.name,
          procedure_id: params.procedureId,
          start_time: params.startTime,
          duration: params.duration,
          fps: params.fps,
          crop: params.crop,
        },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sequences"] });
      queryClient.invalidateQueries({ queryKey: ["video-sequences"] });
      queryClient.invalidateQueries({ queryKey: ["media-library"] });
    },
  });
}
