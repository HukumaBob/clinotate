import { useMutation } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

type Sam2PredictRequest = components["schemas"]["Sam2PredictRequest"];
type Sam2TrackRequest = components["schemas"]["Sam2TrackRequest"];

export function useSam2Predict() {
  return useMutation({
    mutationFn: async (body: Sam2PredictRequest) => {
      const result = await apiClient.POST("/jobs/sam2/predict", { body });
      return result.data;
    },
  });
}

export function useSam2Track() {
  return useMutation({
    mutationFn: async (body: Sam2TrackRequest) => {
      const result = await apiClient.POST("/jobs/sam2/track", { body });
      return result.data;
    },
  });
}
