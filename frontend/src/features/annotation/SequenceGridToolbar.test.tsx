import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
