import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

type BalanceRequest = components["schemas"]["BalanceRequest"];
type DatasetCreate = components["schemas"]["DatasetCreate"];

export function useDatasetBalance(request: BalanceRequest, enabled = true) {
  return useQuery({
    queryKey: ["dataset-balance", request],
    enabled,
    queryFn: async () => {
      const result = await apiClient.POST("/datasets/balance", { body: request });
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useDatasets() {
  return useQuery({
    queryKey: ["datasets"],
    queryFn: async () => {
      const result = await apiClient.GET("/datasets", {});
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useCreateDataset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: DatasetCreate) => {
      const result = await apiClient.POST("/datasets", { body });
      if (result.error) throw result.error;
      return result.data;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export function useExportDataset() {
  return useMutation({
    mutationFn: async (datasetId: number) => {
      const result = await apiClient.POST("/datasets/{dataset_id}/export", {
        params: { path: { dataset_id: datasetId } },
        body: { include_images: true },
      });
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useExportDownload(datasetId: number, jobId: number | null) {
  return useQuery({
    queryKey: ["dataset-export-download", datasetId, jobId],
    enabled: jobId !== null,
    queryFn: async () => {
      const result = await apiClient.GET("/datasets/{dataset_id}/export/{job_id}/download", {
        params: { path: { dataset_id: datasetId, job_id: jobId as number } },
      });
      if (result.error) throw result.error;
      return result.data;
    },
  });
}

export function useDeleteDataset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (datasetId: number) => {
      const result = await apiClient.DELETE("/datasets/{dataset_id}", {
        params: { path: { dataset_id: datasetId } },
      });
      if (result.error) throw result.error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["datasets"] }),
  });
}
