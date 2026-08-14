import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiClient } from "../shared/api/client";
import type { components } from "../shared/api/generated/schema";

type ProcedureCreate = components["schemas"]["ProcedureCreate"];
type ProcedureUpdate = components["schemas"]["ProcedureUpdate"];
type EvaluationTypeCreate = components["schemas"]["EvaluationTypeCreate"];
type EvaluationTypeUpdate = components["schemas"]["EvaluationTypeUpdate"];
type CategoryCreate = components["schemas"]["CategoryCreate"];
type CategoryUpdate = components["schemas"]["CategoryUpdate"];
type LabelCreate = components["schemas"]["LabelCreate"];
type LabelUpdate = components["schemas"]["LabelUpdate"];

export function useProcedures() {
  return useQuery({
    queryKey: ["taxonomy", "procedures"],
    queryFn: async () => {
      const result = await apiClient.GET("/taxonomy/procedures");
      return result.data ?? [];
    },
  });
}

function invalidateProcedures(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["taxonomy", "procedures"] });
  queryClient.invalidateQueries({ queryKey: ["taxonomy", "tree"] });
}

export function useCreateProcedure() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: ProcedureCreate) => {
      const result = await apiClient.POST("/taxonomy/procedures", { body: payload });
      return result;
    },
    onSuccess: () => invalidateProcedures(queryClient),
  });
}

export function useUpdateProcedure() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ procedureId, payload }: { procedureId: number; payload: ProcedureUpdate }) => {
      const result = await apiClient.PATCH("/taxonomy/procedures/{procedure_id}", {
        params: { path: { procedure_id: procedureId } },
        body: payload,
      });
      return result;
    },
    onSuccess: () => invalidateProcedures(queryClient),
  });
}

export function useDeleteProcedure() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (procedureId: number) => {
      const result = await apiClient.DELETE("/taxonomy/procedures/{procedure_id}", {
        params: { path: { procedure_id: procedureId } },
      });
      return result;
    },
    onSuccess: () => invalidateProcedures(queryClient),
  });
}

export function useEvaluationTypes() {
  return useQuery({
    queryKey: ["taxonomy", "evaluation-types"],
    queryFn: async () => {
      const result = await apiClient.GET("/taxonomy/evaluation-types");
      return result.data ?? [];
    },
  });
}

function invalidateEvaluationTypes(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["taxonomy", "evaluation-types"] });
  queryClient.invalidateQueries({ queryKey: ["taxonomy", "tree"] });
}

export function useCreateEvaluationType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: EvaluationTypeCreate) => {
      const result = await apiClient.POST("/taxonomy/evaluation-types", { body: payload });
      return result;
    },
    onSuccess: () => invalidateEvaluationTypes(queryClient),
  });
}

export function useUpdateEvaluationType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      evaluationTypeId,
      payload,
    }: {
      evaluationTypeId: number;
      payload: EvaluationTypeUpdate;
    }) => {
      const result = await apiClient.PATCH("/taxonomy/evaluation-types/{evaluation_type_id}", {
        params: { path: { evaluation_type_id: evaluationTypeId } },
        body: payload,
      });
      return result;
    },
    onSuccess: () => invalidateEvaluationTypes(queryClient),
  });
}

export function useDeleteEvaluationType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (evaluationTypeId: number) => {
      const result = await apiClient.DELETE("/taxonomy/evaluation-types/{evaluation_type_id}", {
        params: { path: { evaluation_type_id: evaluationTypeId } },
      });
      return result;
    },
    onSuccess: () => invalidateEvaluationTypes(queryClient),
  });
}

export function useTagsTree(procedureId: number | null) {
  return useQuery({
    queryKey: ["taxonomy", "tree", procedureId],
    queryFn: async () => {
      const result = await apiClient.GET("/taxonomy/tree", {
        params: { query: procedureId !== null ? { procedure_id: procedureId } : {} },
      });
      return result.data ?? [];
    },
  });
}

export function useLabelMaskCounts() {
  return useQuery({
    queryKey: ["taxonomy", "labels", "mask-counts"],
    queryFn: async () => {
      const result = await apiClient.GET("/taxonomy/labels/mask-counts");
      return result.data ?? {};
    },
  });
}

function invalidateTree(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["taxonomy", "tree"] });
}

export function useCreateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: CategoryCreate) => {
      const result = await apiClient.POST("/taxonomy/categories", { body: payload });
      return result;
    },
    onSuccess: () => invalidateTree(queryClient),
  });
}

export function useUpdateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ categoryId, payload }: { categoryId: number; payload: CategoryUpdate }) => {
      const result = await apiClient.PATCH("/taxonomy/categories/{category_id}", {
        params: { path: { category_id: categoryId } },
        body: payload,
      });
      return result;
    },
    onSuccess: () => invalidateTree(queryClient),
  });
}

export function useDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (categoryId: number) => {
      const result = await apiClient.DELETE("/taxonomy/categories/{category_id}", {
        params: { path: { category_id: categoryId } },
      });
      return result;
    },
    onSuccess: () => invalidateTree(queryClient),
  });
}

export function useCreateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: LabelCreate) => {
      const result = await apiClient.POST("/taxonomy/labels", { body: payload });
      return result;
    },
    onSuccess: () => invalidateTree(queryClient),
  });
}

export function useUpdateLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ labelId, payload }: { labelId: number; payload: LabelUpdate }) => {
      const result = await apiClient.PATCH("/taxonomy/labels/{label_id}", {
        params: { path: { label_id: labelId } },
        body: payload,
      });
      return result;
    },
    onSuccess: () => invalidateTree(queryClient),
  });
}

export function useDeleteLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (labelId: number) => {
      const result = await apiClient.DELETE("/taxonomy/labels/{label_id}", {
        params: { path: { label_id: labelId } },
      });
      return result;
    },
    onSuccess: () => invalidateTree(queryClient),
  });
}
