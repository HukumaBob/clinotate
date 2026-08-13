import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { CategoryForm } from "./CategoryForm";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function mockProcedures() {
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
    return { data: [], error: undefined } as never;
  });
}

describe("CategoryForm", () => {
  afterEach(() => vi.clearAllMocks());

  it("creates a new category with name and procedure", async () => {
    mockProcedures();
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 1, name: "Anatomy", procedure_id: 10 },
      error: undefined,
    } as never);

    const onDone = vi.fn();
    render(<CategoryForm defaultProcedureId={null} onDone={onDone} />, { wrapper });

    await screen.findByLabelText(/^procedure$/i);
    await userEvent.type(screen.getByLabelText(/^name$/i), "Anatomy");
    await userEvent.selectOptions(screen.getByLabelText(/^procedure$/i), "10");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(apiClient.POST).toHaveBeenCalledWith(
      "/taxonomy/categories",
      expect.objectContaining({ body: { name: "Anatomy", procedure_id: 10 } })
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("shows a validation message and does not submit when name is empty", async () => {
    mockProcedures();

    render(<CategoryForm defaultProcedureId={10} onDone={vi.fn()} />, { wrapper });

    await screen.findByLabelText(/^procedure$/i);
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(apiClient.POST).not.toHaveBeenCalled();
    expect(await screen.findByText(/name is required/i)).toBeInTheDocument();
  });

  it("edits an existing category's name and keeps procedure read-only", async () => {
    mockProcedures();
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { id: 5, name: "Anatomy renamed", procedure_id: 10 },
      error: undefined,
    } as never);

    const onDone = vi.fn();
    render(
      <CategoryForm
        defaultProcedureId={null}
        editingCategory={{ id: 5, name: "Anatomy", procedure_id: 10 }}
        onDone={onDone}
      />,
      { wrapper }
    );

    const nameInput = await screen.findByLabelText(/^name$/i);
    expect(nameInput).toHaveValue("Anatomy");
    expect(screen.getByLabelText(/^procedure$/i)).toBeDisabled();

    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Anatomy renamed");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/taxonomy/categories/{category_id}",
      expect.objectContaining({
        params: { path: { category_id: 5 } },
        body: { name: "Anatomy renamed" },
      })
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("shows the backend error message inline when save fails", async () => {
    mockProcedures();
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: undefined,
      error: { detail: "Category already exists" },
    } as never);

    render(<CategoryForm defaultProcedureId={10} onDone={vi.fn()} />, { wrapper });

    await userEvent.type(await screen.findByLabelText(/^name$/i), "Anatomy");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/category already exists/i)).toBeInTheDocument();
  });
});
