# QC screen, sub-project 4: A/B comparison and stress tests

Date: 2026-10-08. Status: implemented and browser-verified. Follows
[inference runs](2026-10-06-qc-inference-runs-design.md),
[inspection](2026-10-06-qc-inspection-design.md) and
[flagging](2026-10-07-qc-flagging-design.md).

## Goal

Let the user compare two stored inference runs of one video frame by frame,
decide which model is right where they disagree, and send the wrong frames to
training through the existing FP/FN flags. A stress test is an ordinary run
whose input frames were degraded, compared against the clean run through the
same screen.

## Decisions

| Question | Decision |
|---|---|
| What is compared | Two finished runs of the same video. The A/B screen never launches inference. |
| What counts as disagreement | Presence and class only: a frame disagrees when the sets of classes found by A and B differ. No IoU, no geometry. |
| Where the thresholds come from | The confidence/NMS sliders of sub-project 2, one value pair per side, passed in the request. |
| How a stress test is made | A `perturbation` parameter on the run, applied by `ml-worker` to the frame before the model. The result is a normal run flagged as a stress run. |
| How errors are fixed | Existing `qc_flags` (FP/FN) and the existing Commit. No new storage for "who was right". |
| Leakage of QC videos into datasets | Decided separately: allowed, warned in the dataset balance panel (commit `6706880`). |

Rejected: launching the second run from the A/B screen (turns it into a job
dispatcher), client-side degradation (the model does not run in the browser),
batch stress series with degradation curves (a third subsystem; wait until one
perturbed run proves useful), IoU-based disagreement (noisy on masks, not
needed to decide who is right).

## Data and API

- `InferenceRun.perturbation`: nullable JSON, `{"kind": "gaussian_noise" |
  "blur" | "brightness" | "jpeg", "strength": number}`. `POST /runs` accepts it
  optionally; kind and strength range are validated, a bad value is a 422.
  Alembic migration, nullable, no backfill.
- `GET /inference/compare?run_a=&run_b=&conf_a=&conf_b=` returns
  `{frames: [{frame, timestamp_ms, only_a: [class], only_b: [class]}], total,
  disagreements}`. 409 with a plain reason when the runs have different
  videos, either is not `succeeded`, or `frame_stride` differs. Disagreements
  are computed server-side from the stored predictions; nothing is persisted.
- Who is right comes from `qc_flags`, which already exist per run and frame.

## ml-worker

`apply_perturbation(frame, spec)` lives in its own pure module (numpy/OpenCV)
and is called in the inference loop before the model. The predictions JSON
format is unchanged apart from a `perturbation` entry in its header. Runs on
CPU, so GPU load equals a normal run. Tests of the pure function run in the
container (`docker cp` + `docker compose exec`, see the ml-worker workflow).

## Frontend

- QC runs table: select two runs and press Compare; disabled with a reason
  when the video or stride differs. Stress runs carry a badge naming the
  perturbation. The run form gets an optional "Perturbation" control.
- A/B screen: model A overlay left, model B overlay right, one shared clock.
  A timeline marks disagreement frames; keyboard navigation like `EventNav`.
  A single summary line: N disagreements out of M frames.
- Fixing: "A wrong" / "B wrong" on the current frame create a flag on the
  wrong run's side. If the wrong model found a class the other did not, the
  flag is FP; if it missed one, FN. Commit is unchanged.

## Out of scope

Stress series and degradation charts, IoU or geometry comparison, classify
models, launching runs from the A/B screen, interpretability (sub-project 5).

## Testing

Backend: disagreement computation, compare 409 cases, perturbation validation.
ml-worker: each perturbation kind. Frontend: pair selection and disabling,
disagreement navigation, A/B wrong buttons choosing FP vs FN. Finally a real
browser run against the real stack, per CLAUDE.md.
