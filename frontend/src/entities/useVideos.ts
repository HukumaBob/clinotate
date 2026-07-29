import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

export function useVideos() {
  return useQuery({
    queryKey: ["videos"],
    queryFn: async () => {
      const result = await apiClient.GET("/media/videos", {});
      return result.data ?? [];
    },
  });
}

export function useUploadVideo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      file,
      title,
      procedureId,
    }: {
      file: File;
      title: string;
      procedureId?: number;
    }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", title);
      if (procedureId !== undefined) {
        formData.append("procedure_id", String(procedureId));
      }
      const result = await apiClient.POST("/media/videos", {
        body: formData as never,
        bodySerializer: (body) => body as unknown as FormData,
      });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["videos"] });
      queryClient.invalidateQueries({ queryKey: ["media-library"] });
    },
  });
}
