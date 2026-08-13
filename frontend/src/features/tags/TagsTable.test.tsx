import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { TagsTable } from "./TagsTable";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const TREE = [
  {
    category: { id: 1, name: "lesion", procedure_id: 10 },
    evaluation_types: [
      {
        evaluation_type: { id: 100, name: "geometric" },
        labels: [
          { id: 1000, name: "0-Ip", color: "#FF0000", category_id: 1, evaluation_type_id: 100, taxonomy_version: 1 },
        ],
      },
    ],
  },
];

function mockTreeAndCounts(counts: Record<string, number> = {}) {
  vi.mocked(apiClient.GET).mockImplementation(async (path) => {
    if (path === "/taxonomy/tree") {
      return { data: TREE, error: undefined } as never;
    }
    if (path === "/taxonomy/labels/mask-counts") {
      return { data: counts, error: undefined } as never;
    }
    if (path === "/taxonomy/procedures") {
      return { data: [{ id: 10, name: "colono" }], error: undefined } as never;
    }
    return { data: [], error: undefined } as never;
  });
}

describe("TagsTable", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders a parent category row and its indented child label row", async () => {
    mockTreeAndCounts();

    render(<TagsTable procedureId={10} />, { wrapper });

    expect(await screen.findByText("lesion")).toBeInTheDocument();
    expect(screen.getByText("0-Ip")).toBeInTheDocument();
    expect(screen.getByText("↳", { exact: false })).toBeInTheDocument();
  });

  it("shows the procedure name on the parent category row", async () => {
    mockTreeAndCounts();

    render(<TagsTable procedureId={10} />, { wrapper });

    expect(await screen.findByRole("cell", { name: "colono" })).toBeInTheDocument();
  });

  it("shows the classification badge only on the child row, not the parent", async () => {
    mockTreeAndCounts();

    render(<TagsTable procedureId={10} />, { wrapper });

    await screen.findByText("0-Ip");
    expect(screen.getByText("geometric")).toBeInTheDocument();
  });

  it("shows the mask count for a label from the mask-counts map", async () => {
    mockTreeAndCounts({ "1000": 7 });

    render(<TagsTable procedureId={10} />, { wrapper });

    expect(await screen.findByText("7")).toBeInTheDocument();
  });

  it("shows zero mask count when the label has no entry in the mask-counts map", async () => {
    mockTreeAndCounts({});

    render(<TagsTable procedureId={10} />, { wrapper });

    await screen.findByText("0-Ip");
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
  });

  it("calls the delete label endpoint when a child row's delete action is confirmed", async () => {
    mockTreeAndCounts();
    vi.mocked(apiClient.DELETE).mockResolvedValue({ data: undefined, error: undefined } as never);

    render(<TagsTable procedureId={10} />, { wrapper });

    await screen.findByText("0-Ip");
    await userEvent.click(screen.getByRole("button", { name: /delete 0-ip/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(apiClient.DELETE).toHaveBeenCalledWith(
      "/taxonomy/labels/{label_id}",
      expect.objectContaining({ params: { path: { label_id: 1000 } } })
    );
  });

  it("shows the 409 error message inline when deleting a category that still has labels", async () => {
    mockTreeAndCounts();
    vi.mocked(apiClient.DELETE).mockResolvedValue({
      data: undefined,
      error: { detail: "Category still has labels referencing it" },
    } as never);

    render(<TagsTable procedureId={10} />, { wrapper });

    await screen.findByText("lesion");
    await userEvent.click(screen.getByRole("button", { name: /delete lesion/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));

    expect(await screen.findByText(/still has labels referencing it/i)).toBeInTheDocument();
  });
});
