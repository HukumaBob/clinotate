import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { TagForm } from "./TagForm";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function mockLookups() {
  vi.mocked(apiClient.GET).mockImplementation(async (path) => {
    if (path === "/taxonomy/procedures") {
      return {
        data: [
          { id: 10, name: "colono" },
          { id: 20, name: "egds" },
        ],
        error: undefined,
      } as never;
    }
    if (path === "/taxonomy/tree") {
      return {
        data: [
          { category: { id: 1, name: "lesion", procedure_id: 10 }, evaluation_types: [] },
          { category: { id: 2, name: "anatomy", procedure_id: 20 }, evaluation_types: [] },
        ],
        error: undefined,
      } as never;
    }
    if (path === "/taxonomy/evaluation-types") {
      return { data: [{ id: 100, name: "geometric" }], error: undefined } as never;
    }
    return { data: [], error: undefined } as never;
  });
}

describe("TagForm", () => {
  afterEach(() => vi.clearAllMocks());

  it("submits a new label with name, procedure, parent category, classification, and color", async () => {
    mockLookups();
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 999, name: "0-Is", color: "#00FF00", category_id: 1, evaluation_type_id: 100, taxonomy_version: 1 },
      error: undefined,
    } as never);

    const onDone = vi.fn();
    render(<TagForm defaultProcedureId={null} onDone={onDone} />, { wrapper });

    await screen.findByLabelText(/procedure/i);
    await userEvent.type(screen.getByLabelText(/^name$/i), "0-Is");
    await userEvent.selectOptions(screen.getByLabelText(/^procedure$/i), "10");
    await userEvent.selectOptions(screen.getByLabelText(/parent tag/i), "1");
    await userEvent.selectOptions(screen.getByLabelText(/classification/i), "100");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(apiClient.POST).toHaveBeenCalledWith(
      "/taxonomy/labels",
      expect.objectContaining({
        body: expect.objectContaining({ name: "0-Is", category_id: 1, evaluation_type_id: 100 }),
      })
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("only offers parent tags belonging to the selected procedure", async () => {
    mockLookups();

    render(<TagForm defaultProcedureId={null} onDone={vi.fn()} />, { wrapper });

    await screen.findByRole("option", { name: "egds" });
    await userEvent.selectOptions(screen.getByLabelText(/^procedure$/i), "20");

    const parentTagSelect = screen.getByLabelText(/parent tag/i) as HTMLSelectElement;
    const optionLabels = Array.from(parentTagSelect.options).map((o) => o.text);
    expect(optionLabels).toContain("anatomy");
    expect(optionLabels).not.toContain("lesion");
  });

  it("shows a validation message and does not submit when name is empty", async () => {
    mockLookups();

    render(<TagForm defaultProcedureId={10} onDone={vi.fn()} />, { wrapper });

    await screen.findByLabelText(/parent tag/i);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(apiClient.POST).not.toHaveBeenCalled();
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
  });

  it("pre-selects the procedure that owns the editing label's category", async () => {
    mockLookups();

    render(
      <TagForm
        defaultProcedureId={null}
        editingLabel={{
          id: 500,
          name: "anatomy-leaf",
          color: "#FFFFFF",
          category_id: 2,
          evaluation_type_id: 100,
          taxonomy_version: 1,
          parent_label_id: null,
          is_abstract: false,
        }}
        onDone={vi.fn()}
      />,
      { wrapper }
    );

    const procedureSelect = (await screen.findByLabelText(/^procedure$/i)) as HTMLSelectElement;
    await waitFor(() => expect(procedureSelect.value).toBe("20"));
  });
});
