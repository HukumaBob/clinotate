import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { TagsPage } from "./TagsPage";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function mockAll() {
  vi.mocked(apiClient.GET).mockImplementation(async (path) => {
    if (path === "/taxonomy/procedures") {
      return { data: [{ id: 10, name: "colono" }], error: undefined } as never;
    }
    if (path === "/taxonomy/evaluation-types") {
      return { data: [{ id: 100, name: "geometric" }], error: undefined } as never;
    }
    if (path === "/taxonomy/labels/mask-counts") {
      return { data: {}, error: undefined } as never;
    }
    if (path === "/taxonomy/tree") {
      return {
        data: [
          {
            category: { id: 1, name: "lesion", procedure_id: 10 },
            evaluation_types: [
              {
                evaluation_type: { id: 100, name: "geometric" },
                labels: [
                  {
                    id: 1000,
                    name: "0-Ip",
                    color: "#FF0000",
                    category_id: 1,
                    evaluation_type_id: 100,
                    taxonomy_version: 1,
                  },
                ],
              },
            ],
          },
        ],
        error: undefined,
      } as never;
    }
    return { data: [], error: undefined } as never;
  });
}

describe("TagsPage", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders the tags table with data from the tree endpoint", async () => {
    mockAll();

    render(<TagsPage />, { wrapper });

    expect(await screen.findByText("0-Ip")).toBeInTheDocument();
  });

  it("opens the new-tag form when '+ New tag' is clicked and closes it after save", async () => {
    mockAll();
    vi.mocked(apiClient.POST).mockResolvedValue({
      data: { id: 2000, name: "0-Is", color: "#00FF00", category_id: 1, evaluation_type_id: 100, taxonomy_version: 1 },
      error: undefined,
    } as never);

    render(<TagsPage />, { wrapper });

    await screen.findByText("0-Ip");
    await userEvent.click(screen.getByRole("button", { name: /new tag/i }));

    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/^name$/i), "0-Is");
    const procedureSelects = screen.getAllByLabelText(/^procedure$/i);
    await userEvent.selectOptions(procedureSelects[procedureSelects.length - 1], "10");
    await userEvent.selectOptions(screen.getByLabelText(/parent tag/i), "1");
    const classificationSelects = screen.getAllByLabelText(/classification/i);
    await userEvent.selectOptions(classificationSelects[classificationSelects.length - 1], "100");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(screen.queryByLabelText(/^name$/i)).not.toBeInTheDocument();
  });

  it("opens the category form when '+ New parent tag' is clicked", async () => {
    mockAll();

    render(<TagsPage />, { wrapper });

    await screen.findByText("0-Ip");
    await userEvent.click(screen.getByRole("button", { name: /new parent tag/i }));

    expect(screen.getByLabelText(/^name$/i)).toBeInTheDocument();
  });

  it("opens the category form pre-filled when a category's Edit action is clicked", async () => {
    mockAll();

    render(<TagsPage />, { wrapper });

    await screen.findByText("lesion");
    await userEvent.click(screen.getByRole("button", { name: /edit lesion/i }));

    expect(await screen.findByDisplayValue("lesion")).toBeInTheDocument();
  });

  it("filters the table by typing in the search box", async () => {
    mockAll();

    render(<TagsPage />, { wrapper });

    await screen.findByText("0-Ip");
    await userEvent.type(screen.getByPlaceholderText(/search/i), "nonexistent");

    expect(screen.queryByText("0-Ip")).not.toBeInTheDocument();
  });
});
