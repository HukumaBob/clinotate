import { useQuery } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";

interface SequencesFilters {
  procedureId: number | null;
  videoId: number | null;
  search: string;
}

export function useSequencesList(
  filters: SequencesFilters & {
    labeled: "all" | "labeled" | "unlabeled";
    page: number;
    pageSize: number;
  },
) {
  return useQuery({
    queryKey: ["sequences-list", filters],
    queryFn: async () => {
      const result = await apiClient.GET("/media/sequences", {
        params: {
          query: {
            procedure_id: filters.procedureId ?? undefined,
            video_id: filters.videoId ?? undefined,
            labeled: filters.labeled,
            search: filters.search || undefined,
            page: filters.page,
            page_size: filters.pageSize,
          },
        },
      });
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useSequencesStats(filters: SequencesFilters) {
  return useQuery({
    queryKey: ["sequences-stats", filters],
    queryFn: async () => {
      const result = await apiClient.GET("/media/sequences/stats", {
        params: {
          query: {
            procedure_id: filters.procedureId ?? undefined,
            video_id: filters.videoId ?? undefined,
            search: filters.search || undefined,
          },
        },
      });
      if (result.error) throw result.error;
      return result.data;
    },
  });
}
