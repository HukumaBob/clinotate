import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export interface MediaLibraryParams {
  search?: string;
  type?: "video" | "photo";
  procedureId?: number;
  sort?: "uploaded_at" | "last_edited_at" | "size_bytes" | "linked_sequence_count";
  order?: "asc" | "desc";
  page: number;
  pageSize: number;
}

export function useMediaLibrary(params: MediaLibraryParams) {
  const { search, type, procedureId, sort, order, page, pageSize } = params;
  return useQuery({
    queryKey: ["media-library", search, type, procedureId, sort, order, page, pageSize],
    queryFn: async () => {
      const result = await apiClient.GET("/media/library", {
        params: {
          query: {
            search: search || undefined,
            type,
            procedure_id: procedureId,
            sort,
            order,
            page,
            page_size: pageSize,
          },
        },
      });
      return result.data;
    },
  });
}

export function useDeleteVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (videoId: number) => {
      const result = await apiClient.DELETE("/media/videos/{video_id}", {
        params: { path: { video_id: videoId } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["media-library"] });
    },
  });
}

export function useDeleteSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sequenceId: number) => {
      const result = await apiClient.DELETE("/media/sequences/{sequence_id}", {
        params: { path: { sequence_id: sequenceId } },
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
