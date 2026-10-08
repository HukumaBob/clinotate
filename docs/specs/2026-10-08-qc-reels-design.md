# QC screen, sub-project 5A: review reels

Date: 2026-10-08. Status: design approved, plan not written. Follows
[flagging](2026-10-07-qc-flagging-design.md) and
[inspection](2026-10-06-qc-inspection-design.md).

Sub-project 5 of the QC module was split on 2026-10-08: this document covers
**A (reels)** only. B (auto-label export) waits for the user's open questions;
C (Grad-CAM) is deferred.

## Goal

On the run screen (`/qc/:runId`), list the clips where the model is in doubt, let
the reviewer loop through them and send frames to training with the existing
FP/FN flags.

## Decisions

| Question | Decision |
|---|---|
| What is doubtful | Flicker events (as the screen already computes them) plus the grey zone: processed frames with a detection whose confidence is within a band, default 0.25 to 0.5, inclusive. |
| Where it lives | A "Review reels" panel on the existing run screen. No new screen, endpoint or table. |
| How frames reach training | Existing flag buttons and F/N keys on the frame currently shown. A clip is "reviewed" when any flag lies inside it. No flag-the-whole-clip action: a clip holds dozens of near-identical frames. |
| Clip shape | The moment plus 1 s on each side, clamped to the video. Clips closer than 2 s merge, reasons unite. Padding and merge gap are constants, not settings. |
| Order | By time. |
| Grey-zone input | Stored predictions before the display threshold, so the band is independent of the confidence slider. |

## Units

- `reels.ts`: pure `buildReels(doc, flickerEvents, band) -> Reel[]` where
  `Reel = {startMs, endMs, reasons: string[], frameIndices: number[]}`, and
  `isReviewed(reel, flags) -> boolean`. No React.
- `ReelsPanel.tsx`: the two band inputs, the clip list (time range, reason
  chips, frame count, reviewed mark), Previous/Next reel.
- `RunViewPage`: holds the active reel and loops playback inside it.

## Behaviour

- Clicking a clip seeks to its start and loops it; clicking it again or another
  clip switches the mode. At the end the video returns to the clip start.
- Empty list: "No doubtful moments at these settings".
- When the screen already warns that the flicker window is too coarse, the same
  warning applies to flicker-based clips.

## Out of scope

Downloadable clips, server-side ffmpeg, flagging a whole clip, new backend,
sub-projects B and C.

## Testing

`buildReels`: band inclusive at both ends, padding clamped to the video, close
clips merge with united reasons, empty input, stride above 1. `ReelsPanel`:
click seeks, loop wraps at the clip end, reviewed mark, empty state. Then a real
browser run against the real stack, as CLAUDE.md requires.
