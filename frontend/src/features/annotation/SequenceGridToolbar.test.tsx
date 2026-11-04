import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SequenceGridToolbar } from "./SequenceGridToolbar";

vi.mock("./TagRegionsPanel", () => ({
  TagRegionsPanel: ({ frameIds, onClose }: { frameIds: number[]; onClose: () => void }) => (
    <div>
      <span>Tag regions panel for {frameIds.join(",")}</span>
      <button type="button" onClick={onClose}>
        Close
      </button>
    </div>
  ),
}));

vi.mock("./FrameCropPanel", () => ({
  FrameCropPanel: ({
    frameIds,
    previewUrl,
    hasVideo,
    onClose,
  }: {
    frameIds: number[];
    previewUrl?: string;
    hasVideo: boolean;
    onClose: () => void;
  }) => (
    <div>
      <span>Crop panel for {frameIds.join(",")}</span>
      <span>preview {previewUrl ?? "none"}</span>
      <span>{hasVideo ? "has video" : "photo set"}</span>
      <button type="button" onClick={onClose}>
        Close crop
      </button>
    </div>
  ),
}));

describe("SequenceGridToolbar", () => {
  it("shows the sequence name, not a numeric id placeholder", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Colonoscopy run 4"
        isSelectMode={false}
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText("Colonoscopy run 4")).toBeInTheDocument();
  });

  it("hides select-mode controls (trash, cancel, count) when not in select mode", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode={false}
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("shows select-mode controls and the selected count when in select mode", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={3}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText(/3 selected/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /delete/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("disables the delete button when selectedCount is 0", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /delete/i })).toBeDisabled();
  });

  it("requires two clicks on delete before calling onDeleteSelected (click-to-arm)", async () => {
    const user = userEvent.setup();
    const onDeleteSelected = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={onDeleteSelected}
        onCancel={() => {}}
      />,
    );

    const deleteButton = screen.getByRole("button", { name: /delete/i });
    await user.click(deleteButton);
    expect(onDeleteSelected).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onDeleteSelected).toHaveBeenCalledTimes(1);
  });

  it("calls onToggleSelectMode when the Select button is clicked", async () => {
    const user = userEvent.setup();
    const onToggleSelectMode = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode={false}
        onToggleSelectMode={onToggleSelectMode}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: /select/i }));
    expect(onToggleSelectMode).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when the Cancel button is clicked", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={1}
        onDeleteSelected={() => {}}
        onCancel={onCancel}
      />,
    );

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the quality percent input and Rank Quality button in select mode", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        qualityPercent={20}
        onQualityPercentChange={() => {}}
        onRankQuality={() => {}}
        isRankQualityRunning={false}
        hasAutoMarks={false}
        onClearMarks={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rank Quality" }));
    expect(screen.getByRole("spinbutton", { name: /quality/i })).toHaveValue(20);
    expect(screen.getByRole("button", { name: "Rank Quality" })).toBeInTheDocument();
  });

  it("calls onRankQuality with no arguments when the Rank Quality button is clicked", async () => {
    const user = userEvent.setup();
    const onRankQuality = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        qualityPercent={20}
        onQualityPercentChange={() => {}}
        onRankQuality={onRankQuality}
        isRankQualityRunning={false}
        hasAutoMarks={false}
        onClearMarks={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rank Quality" }));
    await user.click(screen.getByRole("button", { name: "Run Rank Quality" }));
    expect(onRankQuality).toHaveBeenCalledTimes(1);
  });

  it("disables the Rank Quality button while a rank-quality job is running", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        qualityPercent={20}
        onQualityPercentChange={() => {}}
        onRankQuality={() => {}}
        isRankQualityRunning
        hasAutoMarks={false}
        onClearMarks={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /rank quality/i })).toBeDisabled();
  });

  it("shows Clear marks only when hasAutoMarks is true", () => {
    const { rerender } = render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        qualityPercent={20}
        onQualityPercentChange={() => {}}
        onRankQuality={() => {}}
        isRankQualityRunning={false}
        hasAutoMarks={false}
        onClearMarks={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /clear marks/i })).not.toBeInTheDocument();

    rerender(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        qualityPercent={20}
        onQualityPercentChange={() => {}}
        onRankQuality={() => {}}
        isRankQualityRunning={false}
        hasAutoMarks
        onClearMarks={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: /clear marks/i })).toBeInTheDocument();
  });

  it("clamps an out-of-range quality percent typed above the max down to 99", () => {
    const onQualityPercentChange = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        qualityPercent={20}
        onQualityPercentChange={onQualityPercentChange}
        onRankQuality={() => {}}
        isRankQualityRunning={false}
        hasAutoMarks={false}
        onClearMarks={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rank Quality" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /quality/i }), {
      target: { value: "500" },
    });

    expect(onQualityPercentChange).toHaveBeenCalledWith(99);
  });

  it("clamps an out-of-range quality percent typed below the min up to 1", () => {
    const onQualityPercentChange = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        qualityPercent={20}
        onQualityPercentChange={onQualityPercentChange}
        onRankQuality={() => {}}
        isRankQualityRunning={false}
        hasAutoMarks={false}
        onClearMarks={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rank Quality" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /quality/i }), {
      target: { value: "0" },
    });

    expect(onQualityPercentChange).toHaveBeenCalledWith(1);
  });

  it("clamps an emptied quality percent field up to the min of 1", () => {
    const onQualityPercentChange = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        qualityPercent={20}
        onQualityPercentChange={onQualityPercentChange}
        onRankQuality={() => {}}
        isRankQualityRunning={false}
        hasAutoMarks={false}
        onClearMarks={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rank Quality" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /quality/i }), {
      target: { value: "" },
    });

    expect(onQualityPercentChange).toHaveBeenCalledWith(1);
  });

  it("shows the similarity percent input and Find Similar button in select mode", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        similarityPercent={85}
        onSimilarityPercentChange={() => {}}
        onFindSimilar={() => {}}
        isFindSimilarRunning={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find Similar" }));
    expect(screen.getByRole("spinbutton", { name: /similarity/i })).toHaveValue(85);
    expect(screen.getByRole("button", { name: "Find Similar" })).toBeInTheDocument();
  });

  it("calls onFindSimilar with no arguments when the Find Similar button is clicked", async () => {
    const user = userEvent.setup();
    const onFindSimilar = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        similarityPercent={85}
        onSimilarityPercentChange={() => {}}
        onFindSimilar={onFindSimilar}
        isFindSimilarRunning={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Find Similar" }));
    await user.click(screen.getByRole("button", { name: "Run Find Similar" }));
    expect(onFindSimilar).toHaveBeenCalledTimes(1);
  });

  it("disables the Find Similar button while a find-similar job is running", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        similarityPercent={85}
        onSimilarityPercentChange={() => {}}
        onFindSimilar={() => {}}
        isFindSimilarRunning
      />,
    );

    expect(screen.getByRole("button", { name: /find similar/i })).toBeDisabled();
  });

  it("clamps an out-of-range similarity percent typed above the max down to 99", () => {
    const onSimilarityPercentChange = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        similarityPercent={85}
        onSimilarityPercentChange={onSimilarityPercentChange}
        onFindSimilar={() => {}}
        isFindSimilarRunning={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find Similar" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /similarity/i }), {
      target: { value: "500" },
    });

    expect(onSimilarityPercentChange).toHaveBeenCalledWith(99);
  });

  it("clamps an out-of-range similarity percent typed below the min up to 1", () => {
    const onSimilarityPercentChange = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        similarityPercent={85}
        onSimilarityPercentChange={onSimilarityPercentChange}
        onFindSimilar={() => {}}
        isFindSimilarRunning={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find Similar" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /similarity/i }), {
      target: { value: "0" },
    });

    expect(onSimilarityPercentChange).toHaveBeenCalledWith(1);
  });

  it("clamps an emptied similarity percent field up to the min of 1", () => {
    const onSimilarityPercentChange = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        similarityPercent={85}
        onSimilarityPercentChange={onSimilarityPercentChange}
        onFindSimilar={() => {}}
        isFindSimilarRunning={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Find Similar" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: /similarity/i }), {
      target: { value: "" },
    });

    expect(onSimilarityPercentChange).toHaveBeenCalledWith(1);
  });
});

const sampleTaxonomyTree = [
  {
    category: { id: 1, name: "Landmark", procedure_id: 1 },
    evaluation_types: [
      {
        evaluation_type: { id: 9, name: "frame_classification", annotation_scope: "frame" },
        labels: [
          { id: 101, name: "antrum", color: "#ff0000", category_id: 1, evaluation_type_id: 9, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z", parent_label_id: null, is_abstract: false },
          { id: 102, name: "ge_junction", color: "#00ff00", category_id: 1, evaluation_type_id: 9, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z", parent_label_id: null, is_abstract: false },
        ],
      },
    ],
  },
  {
    category: { id: 2, name: "Quality", procedure_id: 1 },
    evaluation_types: [
      {
        evaluation_type: { id: 9, name: "frame_classification", annotation_scope: "frame" },
        labels: [
          { id: 201, name: "low_quality", color: "#0000ff", category_id: 2, evaluation_type_id: 9, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z", parent_label_id: null, is_abstract: false },
        ],
      },
      {
        evaluation_type: { id: 10, name: "geometric", annotation_scope: "region" },
        labels: [
          { id: 202, name: "foam", color: "#111111", category_id: 2, evaluation_type_id: 10, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z", parent_label_id: null, is_abstract: false },
        ],
      },
    ],
  },
];

describe("SequenceGridToolbar classification controls", () => {
  it("hides classification controls when not in select mode", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode={false}
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        onAssignClassification={() => {}}
        onClearClassification={() => {}}
      />,
    );

    expect(screen.queryByLabelText("Classification category")).not.toBeInTheDocument();
  });

  it("populates the label select from the chosen category", async () => {
    const user = userEvent.setup();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        onAssignClassification={() => {}}
        onClearClassification={() => {}}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Classification category"), "1");

    expect(screen.getByRole("option", { name: "antrum" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "ge_junction" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "low_quality" })).not.toBeInTheDocument();
  });

  it("calls onAssignClassification with the chosen label id when Assign is clicked", async () => {
    const user = userEvent.setup();
    const onAssignClassification = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        onAssignClassification={onAssignClassification}
        onClearClassification={() => {}}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Classification category"), "1");
    await user.selectOptions(screen.getByLabelText("Classification label"), "102");
    await user.click(screen.getByRole("button", { name: "Assign" }));

    expect(onAssignClassification).toHaveBeenCalledWith(102);
  });

  it("disables Assign until both a category and a label are chosen", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        onAssignClassification={() => {}}
        onClearClassification={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
  });

  it("calls onClearClassification with the chosen category id and evaluation type id when Clear is clicked", async () => {
    const user = userEvent.setup();
    const onClearClassification = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        onAssignClassification={() => {}}
        onClearClassification={onClearClassification}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Classification category"), "2");
    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(onClearClassification).toHaveBeenCalledWith(2, 9);
  });

  it("disables Assign and Clear when there is no selection", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        onAssignClassification={() => {}}
        onClearClassification={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("only offers labels from frame-scoped evaluation types in the category dropdown, even when a category has both", async () => {
    const user = userEvent.setup();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={sampleTaxonomyTree}
        onAssignClassification={() => {}}
        onClearClassification={() => {}}
      />,
    );

    const categorySelect = screen.getByLabelText("Classification category");
    const optionLabels = Array.from(categorySelect.querySelectorAll("option")).map((o) => o.textContent);
    expect(optionLabels).toContain("Landmark");
    expect(optionLabels).toContain("Quality");

    await user.selectOptions(categorySelect, "2");
    const labelSelect = screen.getByLabelText("Classification label");
    const labelOptionNames = Array.from(labelSelect.querySelectorAll("option")).map((o) => o.textContent);
    expect(labelOptionNames).toContain("low_quality");
    expect(labelOptionNames).not.toContain("foam");
  });

  it("calls onToggleNoFindings when Mark no findings is clicked", () => {
    const onToggleNoFindings = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode={true}
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        onToggleNoFindings={onToggleNoFindings}
        hasNoFindingsMarkedForAllSelected={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark no findings" }));

    expect(onToggleNoFindings).toHaveBeenCalledTimes(1);
  });

  it("shows Unmark when every selected frame is already marked no findings", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode={true}
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        hasNoFindingsMarkedForAllSelected={true}
      />,
    );

    expect(screen.getByRole("button", { name: "Unmark no findings" })).toBeInTheDocument();
  });

  it("does not offer abstract labels in the classification dropdown", async () => {
    const user = userEvent.setup();
    const tree = [
      {
        category: { id: 3, name: "Quality", procedure_id: 1 },
        evaluation_types: [
          {
            evaluation_type: { id: 9, name: "frame_classification", annotation_scope: "frame" },
            labels: [
              {
                id: 70,
                name: "quality_group",
                color: "#FFFFFF",
                category_id: 3,
                evaluation_type_id: 9,
                taxonomy_version: 1,
                parent_label_id: null,
                is_abstract: true,
              },
              {
                id: 71,
                name: "close_focus",
                color: "#FFFFFF",
                category_id: 3,
                evaluation_type_id: 9,
                taxonomy_version: 1,
                parent_label_id: 70,
                is_abstract: false,
              },
            ],
          },
        ],
      },
    ];

    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        taxonomyTree={tree}
        onAssignClassification={() => {}}
        onClearClassification={() => {}}
      />,
    );

    await user.selectOptions(screen.getByLabelText("Classification category"), "3");

    expect(await screen.findByRole("option", { name: "close_focus" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "quality_group" })).not.toBeInTheDocument();
  });

  it('shows "Select all" and calls onSelectAll', async () => {
    const onSelectAll = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={1}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        totalCount={3}
        onSelectAll={onSelectAll}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(onSelectAll).toHaveBeenCalledTimes(1);
  });

  it('reads "Deselect all" when every frame is selected and calls onDeselectAll', async () => {
    const onDeselectAll = vi.fn();
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={3}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        totalCount={3}
        onDeselectAll={onDeselectAll}
      />,
    );

    expect(screen.queryByRole("button", { name: "Select all" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(onDeselectAll).toHaveBeenCalledTimes(1);
  });

  it("disables the select-all button with no frames", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        totalCount={0}
      />,
    );

    expect(screen.getByRole("button", { name: "Select all" })).toBeDisabled();
  });

  it("does not show select-all outside Select mode", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode={false}
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        totalCount={3}
      />,
    );

    expect(screen.queryByRole("button", { name: /select all/i })).not.toBeInTheDocument();
  });

  it("Tag regions button is disabled with nothing selected and opens the panel", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        sequenceId={7}
        selectedFrameIds={[]}
      />,
    );

    expect(screen.getByRole("button", { name: "Tag regions" })).toBeDisabled();
    expect(screen.queryByText(/Tag regions panel/)).not.toBeInTheDocument();

    rerender(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={2}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        sequenceId={7}
        selectedFrameIds={[4, 5]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Tag regions" }));
    expect(screen.getByText("Tag regions panel for 4,5")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/Tag regions panel/)).not.toBeInTheDocument();
  });

  it("closes the Tag regions panel when the selection empties", async () => {
    const user = userEvent.setup();
    const toolbar = (count: number, ids: number[]) => (
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={count}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        sequenceId={7}
        selectedFrameIds={ids}
      />
    );
    const { rerender } = render(toolbar(2, [4, 5]));
    await user.click(screen.getByRole("button", { name: "Tag regions" }));
    expect(screen.getByText("Tag regions panel for 4,5")).toBeInTheDocument();

    rerender(toolbar(0, []));
    expect(screen.queryByText(/Tag regions panel/)).not.toBeInTheDocument();

    rerender(toolbar(2, [6, 7]));
    expect(screen.queryByText(/Tag regions panel/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tag regions" })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows the selection as 'n of total' with a hint while nothing is ticked", () => {
    const { rerender } = render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        totalCount={142}
      />,
    );
    expect(screen.getByText("0 of 142 selected")).toBeInTheDocument();
    expect(screen.getByText(/Tick frames to classify/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete selected" })).toHaveAttribute("title", "Select frames first");

    rerender(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={17}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
        totalCount={142}
      />,
    );
    expect(screen.getByText("17 of 142 selected")).toBeInTheDocument();
    expect(screen.queryByText(/Tick frames to classify/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete selected" })).toHaveTextContent("Delete 17");
  });

  it("explains the Rank Quality and Find Similar parameters in their popovers", () => {
    render(
      <SequenceGridToolbar
        sequenceName="Seq"
        isSelectMode
        onToggleSelectMode={() => {}}
        selectedCount={0}
        onDeleteSelected={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Rank Quality" }));
    expect(screen.getByText("Tick the worst … % of frames")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Find Similar" }));
    expect(screen.getByText("Duplicate when at least … % similar")).toBeInTheDocument();
  });
});

describe("SequenceGridToolbar crop panel", () => {
  const toolbar = (count: number, ids: number[], extra = {}) => (
    <SequenceGridToolbar
      sequenceName="Seq"
      isSelectMode
      onToggleSelectMode={() => {}}
      selectedCount={count}
      onDeleteSelected={() => {}}
      onCancel={() => {}}
      sequenceId={7}
      selectedFrameIds={ids}
      {...extra}
    />
  );

  it("disables Crop with nothing selected and opens the panel for the selection", async () => {
    const user = userEvent.setup();
    const { rerender } = render(toolbar(0, []));
    expect(screen.getByRole("button", { name: "Crop" })).toBeDisabled();

    rerender(toolbar(2, [4, 5], { firstSelectedImageUrl: "http://x/4.png", sequenceHasVideo: true }));
    await user.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.getByText("Crop panel for 4,5")).toBeInTheDocument();
    expect(screen.getByText("preview http://x/4.png")).toBeInTheDocument();
    expect(screen.getByText("has video")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close crop" }));
    expect(screen.queryByText(/Crop panel/)).not.toBeInTheDocument();
  });

  it("toggles the panel from the button", async () => {
    const user = userEvent.setup();
    render(toolbar(2, [4, 5]));
    await user.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.getByText("Crop panel for 4,5")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.queryByText(/Crop panel/)).not.toBeInTheDocument();
  });

  it("shows one popover at a time: Crop and Tag regions close each other", async () => {
    const user = userEvent.setup();
    render(toolbar(2, [4, 5]));
    await user.click(screen.getByRole("button", { name: "Tag regions" }));
    expect(screen.getByText(/Tag regions panel/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Crop" }));
    expect(screen.getByText("Crop panel for 4,5")).toBeInTheDocument();
    expect(screen.queryByText(/Tag regions panel/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Tag regions" }));
    expect(screen.getByText(/Tag regions panel/)).toBeInTheDocument();
    expect(screen.queryByText(/Crop panel/)).not.toBeInTheDocument();
  });

  it("closes the panel when the selection empties", async () => {
    const user = userEvent.setup();
    const { rerender } = render(toolbar(2, [4, 5]));
    await user.click(screen.getByRole("button", { name: "Crop" }));
    rerender(toolbar(0, []));
    expect(screen.queryByText(/Crop panel/)).not.toBeInTheDocument();
    rerender(toolbar(2, [6, 7]));
    expect(screen.queryByText(/Crop panel/)).not.toBeInTheDocument();
  });
});
