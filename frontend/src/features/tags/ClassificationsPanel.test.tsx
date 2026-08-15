import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { ClassificationsPanel } from "./ClassificationsPanel";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function mockEvaluationTypes() {
  vi.mocked(apiClient.GET).mockImplementation(async (path) => {
    if (path === "/taxonomy/evaluation-types") {
      return {
        data: [{ id: 100, name: "geometric", annotation_scope: "region" }],
        error: undefined,
      } as never;
    }
    return { data: [], error: undefined } as never;
  });
}

describe("ClassificationsPanel", () => {
  afterEach(() => vi.clearAllMocks());

  it("lists existing classifications", async () => {
    mockEvaluationTypes();

    render(<ClassificationsPanel />, { wrapper });

    expect(await screen.findByText("geometric")).toBeInTheDocument();
  });

  it("requires a scope choice before creating a new classification", async () => {
    mockEvaluationTypes();

    render(<ClassificationsPanel />, { wrapper });

    await screen.findByText("geometric");
    await userEvent.type(screen.getByPlaceholderText(/new classification/i), "morphological");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(apiClient.POST).not.toHaveBeenCalled();
    expect(screen.getByText(/scope is required/i)).toBeInTheDocument();
  });

  it("creates a new classification with the chosen scope from the inline form", async () => {
    mockEvaluationTypes();
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 200, name: "morphological", annotation_scope: "region" },
      error: undefined,
    } as never);

    render(<ClassificationsPanel />, { wrapper });

    await screen.findByText("geometric");
    await userEvent.type(screen.getByPlaceholderText(/new classification/i), "morphological");
    await userEvent.click(screen.getByLabelText(/^region$/i));
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(apiClient.POST).toHaveBeenCalledWith(
      "/taxonomy/evaluation-types",
      expect.objectContaining({ body: { name: "morphological", annotation_scope: "region" } })
    );
  });

  it("turns delete into a confirm button in place, matching MediaLibraryTable's pattern", async () => {
    mockEvaluationTypes();
    vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined } as never);

    render(<ClassificationsPanel />, { wrapper });

    await screen.findByText("geometric");
    await userEvent.click(screen.getByRole("button", { name: /delete geometric/i }));

    expect(screen.getByRole("button", { name: /confirm delete geometric/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /confirm delete geometric/i }));

    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/taxonomy/evaluation-types/{evaluation_type_id}",
      expect.objectContaining({ params: { path: { evaluation_type_id: 100 } } })
    );
  });

  it("shows the 409 error message inline when a classification still has labels", async () => {
    mockEvaluationTypes();
    vi.mocked(apiClient.DELETE).mockResolvedValue({
      data: undefined,
      error: { detail: "Evaluation type still has labels referencing it" },
    } as never);

    render(<ClassificationsPanel />, { wrapper });

    await screen.findByText("geometric");
    await userEvent.click(screen.getByRole("button", { name: /delete geometric/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm delete geometric/i }));

    expect(await screen.findByText(/still has labels referencing it/i)).toBeInTheDocument();
  });

  it("renames a classification via inline edit", async () => {
    mockEvaluationTypes();
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { id: 100, name: "geometric renamed" },
      error: undefined,
    } as never);

    render(<ClassificationsPanel />, { wrapper });

    await screen.findByText("geometric");
    await userEvent.click(screen.getByRole("button", { name: /edit geometric/i }));

    const input = screen.getByDisplayValue("geometric");
    await userEvent.clear(input);
    await userEvent.type(input, "geometric renamed");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/taxonomy/evaluation-types/{evaluation_type_id}",
      expect.objectContaining({
        params: { path: { evaluation_type_id: 100 } },
        body: { name: "geometric renamed" },
      })
    );
  });
});
