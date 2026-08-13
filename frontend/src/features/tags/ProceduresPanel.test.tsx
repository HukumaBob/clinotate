import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { ProceduresPanel } from "./ProceduresPanel";

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
      return { data: [{ id: 10, name: "colono" }], error: undefined } as never;
    }
    return { data: [], error: undefined } as never;
  });
}

describe("ProceduresPanel", () => {
  afterEach(() => vi.clearAllMocks());

  it("lists existing procedures", async () => {
    mockProcedures();

    render(<ProceduresPanel />, { wrapper });

    expect(await screen.findByText("colono")).toBeInTheDocument();
  });

  it("creates a new procedure from the inline form", async () => {
    mockProcedures();
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 20, name: "egds" },
      error: undefined,
    } as never);

    render(<ProceduresPanel />, { wrapper });

    await screen.findByText("colono");
    await userEvent.type(screen.getByPlaceholderText(/new procedure/i), "egds");
    await userEvent.click(screen.getByRole("button", { name: /^add$/i }));

    expect(apiClient.POST).toHaveBeenCalledWith(
      "/taxonomy/procedures",
      expect.objectContaining({ body: { name: "egds" } })
    );
  });

  it("turns delete into a confirm button in place, matching MediaLibraryTable's pattern", async () => {
    mockProcedures();
    vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined } as never);

    render(<ProceduresPanel />, { wrapper });

    await screen.findByText("colono");
    await userEvent.click(screen.getByRole("button", { name: /delete colono/i }));

    expect(screen.getByRole("button", { name: /confirm delete colono/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /confirm delete colono/i }));

    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/taxonomy/procedures/{procedure_id}",
      expect.objectContaining({ params: { path: { procedure_id: 10 } } })
    );
  });

  it("shows the 409 error message inline when a procedure still has categories", async () => {
    mockProcedures();
    vi.mocked(apiClient.DELETE).mockResolvedValue({
      data: undefined,
      error: { detail: "Procedure still has categories referencing it" },
    } as never);

    render(<ProceduresPanel />, { wrapper });

    await screen.findByText("colono");
    await userEvent.click(screen.getByRole("button", { name: /delete colono/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm delete colono/i }));

    expect(await screen.findByText(/still has categories referencing it/i)).toBeInTheDocument();
  });

  it("renames a procedure via inline edit", async () => {
    mockProcedures();
    vi.mocked(apiClient.PATCH).mockResolvedValue({
      data: { id: 10, name: "colono renamed" },
      error: undefined,
    } as never);

    render(<ProceduresPanel />, { wrapper });

    await screen.findByText("colono");
    await userEvent.click(screen.getByRole("button", { name: /edit colono/i }));

    const input = screen.getByDisplayValue("colono");
    await userEvent.clear(input);
    await userEvent.type(input, "colono renamed");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(apiClient.PATCH).toHaveBeenCalledWith(
      "/taxonomy/procedures/{procedure_id}",
      expect.objectContaining({
        params: { path: { procedure_id: 10 } },
        body: { name: "colono renamed" },
      })
    );
  });
});
