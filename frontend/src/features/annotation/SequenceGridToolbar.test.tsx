import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SequenceGridToolbar } from "./SequenceGridToolbar";

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

    expect(screen.getByRole("spinbutton", { name: /quality/i })).toHaveValue(20);
    expect(screen.getByRole("button", { name: /rank quality/i })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: /rank quality/i }));
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

    expect(screen.getByRole("spinbutton", { name: /similarity/i })).toHaveValue(85);
    expect(screen.getByRole("button", { name: /find similar/i })).toBeInTheDocument();
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

    await user.click(screen.getByRole("button", { name: /find similar/i }));
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
        evaluation_type: { id: 9, name: "Frame classification" },
        labels: [
          { id: 101, name: "antrum", color: "#ff0000", category_id: 1, evaluation_type_id: 9, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z" },
          { id: 102, name: "ge_junction", color: "#00ff00", category_id: 1, evaluation_type_id: 9, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z" },
        ],
      },
    ],
  },
  {
    category: { id: 2, name: "Quality", procedure_id: 1 },
    evaluation_types: [
      {
        evaluation_type: { id: 9, name: "Frame classification" },
        labels: [
          { id: 201, name: "low_quality", color: "#0000ff", category_id: 2, evaluation_type_id: 9, taxonomy_version: 1, created_at: "2026-01-01T00:00:00Z" },
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
        frameClassificationEvaluationTypeName="Frame classification"
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
        frameClassificationEvaluationTypeName="Frame classification"
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
        frameClassificationEvaluationTypeName="Frame classification"
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
        frameClassificationEvaluationTypeName="Frame classification"
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
        frameClassificationEvaluationTypeName="Frame classification"
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
        frameClassificationEvaluationTypeName="Frame classification"
        onAssignClassification={() => {}}
        onClearClassification={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: "Assign" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });
});
