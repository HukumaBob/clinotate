import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "../../shared/api/client";
import { DatasetsPage } from "./DatasetsPage";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn(), POST: vi.fn(), DELETE: vi.fn() },
}));

// DatasetsPage debounces the balance request by 300ms; wait comfortably
// past that before reading the last request, since a shorter waitFor() can
// resolve early against a stale pre-keystroke request.
const DEBOUNCE_WAIT_MS = 500;

const SEQUENCES = {
  items: [
    { id: 1, name: "seq-a", video_id: 1, procedure_id: 1, frame_count: 100, labeled_frame_count: 10, preview_frames: [] },
    { id: 2, name: "seq-b", video_id: 1, procedure_id: 1, frame_count: 50, labeled_frame_count: 0, preview_frames: [] },
  ],
  total: 2,
};

const BALANCE = {
  classes: [{ label_id: 1, name: "polyp", instances: 35, frames: 33 }],
  total_frames: 33,
  negative_frames: 0,
  below_threshold: [],
  threshold: 10,
  metrics: { severity: "moderate_imbalance" },
  recommendations: [],
};

const BALANCE_WITHOUT_POLYP = {
  classes: [],
  total_frames: 33,
  negative_frames: 0,
  below_threshold: [],
  threshold: 10,
  metrics: { severity: "no_data" },
};

const TREE = [
  {
    id: 1,
    name: "category",
    evaluation_types: [
      {
        id: 1,
        name: "eval-type",
        labels: [{ id: 1, name: "polyp", parent_label_id: null, taxonomy_version: 1 }],
      },
    ],
  },
];

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("DatasetsPage", () => {
  beforeEach(() => {
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/media/sequences") return { data: SEQUENCES };
      if (path === "/datasets") return { data: [] };
      if (path === "/taxonomy/procedures") return { data: [] };
      if (path === "/taxonomy/tree") return { data: TREE };
      return { data: [] };
    });
    vi.mocked(apiClient.POST).mockResolvedValue({ data: BALANCE });
  });

  it("lists selectable sequences", async () => {
    render(<DatasetsPage />, { wrapper });
    expect(await screen.findByText("seq-a")).toBeInTheDocument();
    expect(screen.getByText("seq-b")).toBeInTheDocument();
  });

  it("requests a balance recompute when a sequence is selected", async () => {
    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));

    await waitFor(() => {
      const balanceCalls = vi
        .mocked(apiClient.POST)
        .mock.calls.filter(([path]) => path === "/datasets/balance");
      expect(balanceCalls.length).toBeGreaterThan(0);
      expect(balanceCalls.at(-1)?.[1]?.body?.sequence_ids).toContain(1);
    });
  });

  it("disables saving until the dataset has a name", async () => {
    render(<DatasetsPage />, { wrapper });
    expect(await screen.findByRole("button", { name: /save dataset/i })).toBeDisabled();

    await userEvent.click(await screen.findByLabelText(/select seq-a/i));
    await userEvent.type(screen.getByLabelText(/name/i), "my-dataset");
    expect(screen.getByRole("button", { name: /save dataset/i })).toBeEnabled();
  });

  it("shows Test percentage as the computed remainder", async () => {
    render(<DatasetsPage />, { wrapper });
    await waitFor(() => expect(screen.getByTestId("test-remainder")).toHaveTextContent("10"));
  });

  it("disables saving with zero sequences selected, and enables once one is picked", async () => {
    render(<DatasetsPage />, { wrapper });
    await userEvent.type(screen.getByLabelText(/name/i), "my-dataset");
    expect(screen.getByRole("button", { name: /save dataset/i })).toBeDisabled();

    await userEvent.click(await screen.findByLabelText(/select seq-a/i));
    expect(screen.getByRole("button", { name: /save dataset/i })).toBeEnabled();
  });

  it("disables saving and shows a message when train + val exceeds 100", async () => {
    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));
    await userEvent.type(screen.getByLabelText(/name/i), "my-dataset");
    expect(screen.getByRole("button", { name: /save dataset/i })).toBeEnabled();

    const trainInput = screen.getByLabelText(/train %/i);
    await userEvent.clear(trainInput);
    await userEvent.type(trainInput, "70");
    const valInput = screen.getByLabelText(/val %/i);
    await userEvent.clear(valInput);
    await userEvent.type(valInput, "50");

    const saveButton = screen.getByRole("button", { name: /save dataset/i });
    expect(saveButton).toBeDisabled();
    const message = screen.getByText(/train.*val.*(must not exceed|<=|exceed).*100/i);
    expect(message).toBeInTheDocument();
    expect(message).toHaveAttribute("role", "alert");
    expect(saveButton.getAttribute("aria-describedby")?.split(" ")).toContain(message.id);
  });

  it("disables saving while a create mutation is pending", async () => {
    let resolveCreate: (() => void) | undefined;
    vi.mocked(apiClient.POST).mockImplementation(async (path: string) => {
      if (path === "/datasets") {
        return new Promise((resolve) => {
          resolveCreate = () => resolve({ data: { id: 1 } });
        });
      }
      return { data: BALANCE };
    });

    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));
    await userEvent.type(screen.getByLabelText(/name/i), "my-dataset");

    const saveButton = screen.getByRole("button", { name: /save dataset/i });
    expect(saveButton).toBeEnabled();
    await userEvent.click(saveButton);

    await waitFor(() => expect(saveButton).toBeDisabled());

    resolveCreate?.();
  });

  it("lets a user re-include a class after excluding it", async () => {
    vi.mocked(apiClient.POST).mockImplementation(async (path: string, options?: { body?: { excluded_label_ids?: number[] } }) => {
      if (path === "/datasets/balance") {
        const excludedIds = options?.body?.excluded_label_ids ?? [];
        return { data: excludedIds.includes(1) ? BALANCE_WITHOUT_POLYP : BALANCE };
      }
      return { data: BALANCE };
    });

    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));
    await screen.findByTestId("exclude-1");

    await userEvent.click(screen.getByTestId("exclude-1"));

    await waitFor(() => {
      const section = screen.getByTestId("excluded-classes");
      expect(section).toHaveTextContent("polyp");
    });

    await userEvent.click(screen.getByRole("button", { name: "Re-include polyp" }));

    await waitFor(() => {
      expect(screen.queryByTestId("excluded-classes")).not.toBeInTheDocument();
    });
    expect(await screen.findByTestId("exclude-1")).toBeInTheDocument();
  });

  it("sends a class limit in the balance request", async () => {
    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));

    const limitInput = await screen.findByLabelText(/limit polyp/i);
    await userEvent.clear(limitInput);
    await userEvent.type(limitInput, "20");

    await waitFor(() => {
      const calls = vi.mocked(apiClient.POST).mock.calls.filter(([p]) => p === "/datasets/balance");
      expect(calls.at(-1)?.[1]?.body?.class_limits).toEqual({ 1: 20 });
    });
  });

  it("treats a limit of 0 as clearing the cap, not as a real limit", async () => {
    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));

    const limitInput = (await screen.findByLabelText(/limit polyp/i)) as HTMLInputElement;
    await userEvent.clear(limitInput);
    await userEvent.type(limitInput, "0");

    // Wait past the debounce window for real, then assert on the settled
    // request -- a waitFor() here can resolve early against a stale
    // pre-keystroke request whose class_limits happens to also be {}.
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));
    const calls = vi.mocked(apiClient.POST).mock.calls.filter(([p]) => p === "/datasets/balance");
    expect(calls.at(-1)?.[1]?.body?.class_limits).toEqual({});
  });

  it("treats a negative limit as clearing the cap", async () => {
    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));

    const limitInput = (await screen.findByLabelText(/limit polyp/i)) as HTMLInputElement;
    await userEvent.clear(limitInput);
    // A number input with min=1 won't let userEvent.type land a leading "-"
    // in .value at all (matching real browser behavior), so drive the
    // negative value through a raw change event instead -- this is exactly
    // the path a spinner/paste/programmatic value could still take.
    fireEvent.change(limitInput, { target: { value: "-5" } });

    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WAIT_MS));
    const calls = vi.mocked(apiClient.POST).mock.calls.filter(([p]) => p === "/datasets/balance");
    expect(calls.at(-1)?.[1]?.body?.class_limits).toEqual({});
  });

  it("clears an existing cap when the input is emptied", async () => {
    render(<DatasetsPage />, { wrapper });
    await userEvent.click(await screen.findByLabelText(/select seq-a/i));

    await userEvent.clear(await screen.findByLabelText(/limit polyp/i));
    await userEvent.type(await screen.findByLabelText(/limit polyp/i), "20");
    await waitFor(() => {
      const calls = vi.mocked(apiClient.POST).mock.calls.filter(([p]) => p === "/datasets/balance");
      expect(calls.at(-1)?.[1]?.body?.class_limits).toEqual({ 1: 20 });
    });

    await userEvent.clear(await screen.findByLabelText(/limit polyp/i));

    await waitFor(() => {
      const calls = vi.mocked(apiClient.POST).mock.calls.filter(([p]) => p === "/datasets/balance");
      expect(calls.at(-1)?.[1]?.body?.class_limits).toEqual({});
    });
  });

  it("shows per-scope annotation counts and the owning video in the picker", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/media/sequences") {
        return {
          data: {
            items: [
              {
                id: 1,
                name: "seq-a",
                video_id: 7,
                procedure_id: 1,
                frame_count: 100,
                labeled_frame_count: 10,
                preview_frames: [],
                region_annotation_count: 12,
                frame_annotation_count: 3,
              },
              SEQUENCES.items[1],
            ],
            total: 2,
          },
        };
      }
      if (path === "/datasets") return { data: [] };
      if (path === "/taxonomy/procedures") return { data: [] };
      if (path === "/taxonomy/tree") return { data: TREE };
      return { data: [] };
    });

    render(<DatasetsPage />, { wrapper });
    const row = (await screen.findByText("seq-a")).closest("tr")!;
    expect(row).toHaveTextContent("12");
    expect(row).toHaveTextContent("3");
    expect(row).toHaveTextContent("7");
  });
});
