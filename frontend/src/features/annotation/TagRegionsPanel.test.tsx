import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  useRegionLabels,
  useRemoveCopiesPreview,
  useRemoveRegionCopies,
  useTagRegions,
  useTagRegionsPreview,
} from "../../entities/useAnnotations";
import { TagRegionsPanel } from "./TagRegionsPanel";

vi.mock("../../entities/useAnnotations");

function label(id: number, name: string, categoryId: number, evaluationTypeId: number, isAbstract = false) {
  return {
    id,
    name,
    color: "#ffffff",
    category_id: categoryId,
    evaluation_type_id: evaluationTypeId,
    taxonomy_version: 1,
    created_at: "2026-01-01T00:00:00Z",
    parent_label_id: null,
    is_abstract: isAbstract,
  };
}

const taxonomyTree = [
  {
    category: { id: 1, name: "Morphology", procedure_id: 1 },
    evaluation_types: [
      {
        evaluation_type: { id: 20, name: "paris", annotation_scope: "region" },
        labels: [label(301, "paris_group", 1, 20, true), label(302, "0-Is", 1, 20), label(303, "0-Ip", 1, 20)],
      },
      {
        evaluation_type: { id: 21, name: "frame_cls", annotation_scope: "frame" },
        labels: [label(304, "frame_only", 1, 21)],
      },
    ],
  },
  {
    category: { id: 2, name: "Landmark", procedure_id: 1 },
    evaluation_types: [
      {
        evaluation_type: { id: 22, name: "frame_cls", annotation_scope: "frame" },
        labels: [label(305, "antrum", 2, 22)],
      },
    ],
  },
] as never;

const regionLabels = [
  { label_id: 11, name: "polyp", count: 12, category_name: "Findings" },
  { label_id: 12, name: "erosion", count: 3, category_name: "Findings" },
];

function tagPreview(overrides: Record<string, unknown> = {}) {
  return {
    dry_run: true,
    regions: 28,
    frames: 9,
    skipped_already_copied: 0,
    already_copied_label_names: [],
    frames_with_manual_regions: 0,
    skipped_manual_frames: 0,
    ...overrides,
  };
}

const tagMutate = vi.fn();
const removeMutate = vi.fn();

function setup({
  labels = regionLabels,
  preview = tagPreview(),
  removePreview = { dry_run: true, removed: 5, kept_reviewed: 2 },
}: {
  labels?: typeof regionLabels;
  preview?: ReturnType<typeof tagPreview> | undefined;
  removePreview?: { dry_run: boolean; removed: number; kept_reviewed: number };
} = {}) {
  vi.mocked(useRegionLabels).mockReturnValue({ data: labels, isLoading: false } as never);
  vi.mocked(useTagRegionsPreview).mockImplementation(
    (params) =>
      ({
        data: params ? preview : undefined,
        isFetching: false,
        isError: false,
        error: null,
      }) as never,
  );
  vi.mocked(useRemoveCopiesPreview).mockImplementation(
    (params) =>
      ({
        data: params ? removePreview : undefined,
        isFetching: false,
        isError: false,
        error: null,
      }) as never,
  );
  vi.mocked(useTagRegions).mockReturnValue({ mutate: tagMutate, isPending: false } as never);
  vi.mocked(useRemoveRegionCopies).mockReturnValue({ mutate: removeMutate, isPending: false } as never);
}

function renderPanel(onClose = vi.fn()) {
  render(<TagRegionsPanel sequenceId={7} frameIds={[1, 2, 3]} taxonomyTree={taxonomyTree} onClose={onClose} />);
  return onClose;
}

async function pickCreateInputs(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText("Source label"), "11");
  await user.selectOptions(screen.getByLabelText("Target category"), "1");
  await user.selectOptions(screen.getByLabelText("Target label"), "302");
}

describe("TagRegionsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists source labels with counts", () => {
    setup();
    renderPanel();

    expect(screen.getByText("Tag regions on 3 selected frames")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "polyp (12)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "erosion (3)" })).toBeInTheDocument();
  });

  it("shows the empty state", () => {
    setup({ labels: [] });
    renderPanel();

    expect(screen.getByText("No regions on the selected frames")).toBeInTheDocument();
  });

  it("preview text reflects the dry-run numbers and names skipped labels", async () => {
    const user = userEvent.setup();
    setup({
      preview: tagPreview({
        skipped_already_copied: 4,
        already_copied_label_names: ["0-Ip", "0-IIa"],
        frames_with_manual_regions: 2,
        skipped_manual_frames: 2,
      }),
    });
    renderPanel();
    await pickCreateInputs(user);

    expect(screen.getByText("Will create 28 regions on 9 frames.")).toBeInTheDocument();
    expect(screen.getByText("Skipped: 4 already tagged as 0-Ip, 0-IIa.")).toBeInTheDocument();
    expect(screen.getByText("2 frames have hand-drawn regions of this type — skipped")).toBeInTheDocument();
  });

  it("Create button states the number and is disabled at zero", async () => {
    const user = userEvent.setup();
    setup({ preview: tagPreview({ regions: 0, frames: 0 }) });
    renderPanel();

    expect(screen.getByRole("button", { name: "Create 0 regions" })).toBeDisabled();
    await pickCreateInputs(user);
    expect(screen.getByRole("button", { name: "Create 0 regions" })).toBeDisabled();
  });

  it("Create calls useTagRegions with the chosen labels and skip flag", async () => {
    const user = userEvent.setup();
    setup();
    tagMutate.mockImplementation((_params, options) =>
      options?.onSuccess?.({ ...tagPreview(), dry_run: false }),
    );
    const onClose = renderPanel();
    await pickCreateInputs(user);

    const createButton = screen.getByRole("button", { name: "Create 28 regions" });
    expect(createButton).toBeEnabled();
    await user.click(createButton);

    expect(useTagRegions).toHaveBeenCalledWith(7);
    expect(tagMutate).toHaveBeenCalledWith(
      { frameIds: [1, 2, 3], sourceLabelId: 11, targetLabelId: 302, skipManualFrames: true },
      expect.anything(),
    );
    expect(screen.getByText("Created 28 regions on 9 frames.")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("unchecking the skip box changes the preview params", async () => {
    const user = userEvent.setup();
    setup({ preview: tagPreview({ frames_with_manual_regions: 2 }) });
    renderPanel();
    await pickCreateInputs(user);

    const checkbox = screen.getByLabelText("Skip frames that already have hand-drawn regions of this type");
    expect(checkbox).toBeChecked();
    expect(useTagRegionsPreview).toHaveBeenLastCalledWith({
      frameIds: [1, 2, 3],
      sourceLabelId: 11,
      targetLabelId: 302,
      skipManualFrames: true,
    });

    await user.click(checkbox);

    expect(useTagRegionsPreview).toHaveBeenLastCalledWith({
      frameIds: [1, 2, 3],
      sourceLabelId: 11,
      targetLabelId: 302,
      skipManualFrames: false,
    });
    expect(screen.getByText("2 frames have hand-drawn regions of this type")).toBeInTheDocument();
  });

  it("target list excludes abstract and frame-scoped labels", async () => {
    const user = userEvent.setup();
    setup();
    renderPanel();

    const categoryOptions = Array.from(
      screen.getByLabelText("Target category").querySelectorAll("option"),
    ).map((option) => option.textContent);
    expect(categoryOptions).toContain("Morphology");
    expect(categoryOptions).not.toContain("Landmark");

    await user.selectOptions(screen.getByLabelText("Target category"), "1");
    const labelOptions = Array.from(screen.getByLabelText("Target label").querySelectorAll("option")).map(
      (option) => option.textContent,
    );
    expect(labelOptions).toContain("0-Is");
    expect(labelOptions).toContain("0-Ip");
    expect(labelOptions).not.toContain("paris_group");
    expect(labelOptions).not.toContain("frame_only");
  });

  it("Remove mode shows reviewed-kept note and needs a second click to confirm", async () => {
    const user = userEvent.setup();
    setup();
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Remove copies" }));
    await user.selectOptions(screen.getByLabelText("Target category"), "1");
    await user.selectOptions(screen.getByLabelText("Target label"), "302");

    expect(useRemoveCopiesPreview).toHaveBeenLastCalledWith({ frameIds: [1, 2, 3], targetLabelId: 302 });
    expect(screen.getByText("Will remove 5 copies. 2 reviewed copies are kept.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove 5 copies" }));
    expect(removeMutate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirm" }));
    expect(removeMutate).toHaveBeenCalledWith({ frameIds: [1, 2, 3], targetLabelId: 302 }, expect.anything());
  });

  it("Esc and Close call onClose", async () => {
    const user = userEvent.setup();
    setup();
    const onClose = renderPanel();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("a failed Create shows its error message", async () => {
    const user = userEvent.setup();
    setup();
    tagMutate.mockImplementation((_params, options) =>
      options?.onError?.(new Error("Target label belongs to another procedure")),
    );
    renderPanel();
    await pickCreateInputs(user);

    await user.click(screen.getByRole("button", { name: "Create 28 regions" }));

    expect(screen.getByText("Target label belongs to another procedure")).toBeInTheDocument();
    expect(screen.queryByText(/^Created /)).not.toBeInTheDocument();
  });

  it("a failed Remove shows its error message", async () => {
    const user = userEvent.setup();
    setup();
    removeMutate.mockImplementation((_params, options) => options?.onError?.(new Error("Request failed")));
    renderPanel();

    await user.click(screen.getByRole("button", { name: "Remove copies" }));
    await user.selectOptions(screen.getByLabelText("Target category"), "1");
    await user.selectOptions(screen.getByLabelText("Target label"), "302");
    await user.click(screen.getByRole("button", { name: "Remove 5 copies" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(screen.getByText("Request failed")).toBeInTheDocument();
    expect(screen.queryByText(/^Removed /)).not.toBeInTheDocument();
  });
});
