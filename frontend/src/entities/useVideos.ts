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
    mutationFn: async ({ file, title }: { file: File; title: string }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("title", title);
      const result = await apiClient.POST("/media/videos", {
        body: formData as never,
        bodySerializer: (body) => body as unknown as FormData,
      });
      return result.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["videos"] });
    },
  });
}
