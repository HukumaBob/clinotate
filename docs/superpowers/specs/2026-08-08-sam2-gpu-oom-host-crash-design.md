# SAM2/SAM3 tracking GPU OOM causing host reboot — design

## Problem

Running SAM2 (and, presumably, SAM3) video tracking from the sequence/frame
editor (e.g. `http://localhost:5173/sequences/1975`) can exhaust GPU VRAM
badly enough that **the entire host machine reboots** — not just the
`ml-worker` container or its Celery process. This has been observed with
tracking ranges as small as ~20-30 frames at ~800x640 resolution.

The existing VRAM gauge (see
`docs/superpowers/specs/2026-08-05-gpu-vram-gauge-design.md`) is purely
reactive/visual and polls too infrequently (job-scoped, updated once per
frame during an active job) to react before a crash. There is no pre-flight
memory estimate, no upper bound on tracking range, and no hard programmatic
cap on how much VRAM the `ml-worker` process may claim.

### Host facts (gathered 2026-08-08)

- GPU: NVIDIA GeForce RTX 2070, 8192 MiB total VRAM, driver 580.173.02.
- This is a desktop machine, not a headless GPU server: Xorg + gnome-shell +
  a browser/Electron process are also resident on the GPU, currently using
  ~350 MiB combined. The user wants ~1 GiB of headroom reserved for the
  desktop beyond what's currently observed, i.e. ~1.3-1.5 GiB total off
  limits to `ml-worker`.
- No ECC (consumer card — N/A), no ECC-related failure mode possible.
- No Xid/OOM-killer lines found in `journalctl -k` for the current boot;
  `dmesg` is not readable without elevated privileges in this environment,
  and the journal only covers the current boot, so kernel-level crash
  evidence from prior incidents could not be directly confirmed. Treat the
  "host reboots" report as the operating hypothesis; the design does not
  depend on knowing the exact driver-level failure mode, since the fix
  prevents the process from ever approaching the point where the driver
  could be pushed into that state.
- cgroup v2 is active but does not constrain GPU VRAM directly; VRAM
  limiting must happen at the CUDA/application level
  (`torch.cuda.set_per_process_memory_fraction`), not via cgroups.
- GPU upgrade is a possible future step but not imminent — this design must
  work within the current 8 GiB card.
- Only `ml-worker` is a Docker/GPU compute consumer in this stack; the
  other GPU processes are desktop-session processes outside Docker.

## Non-goals

- GPU upgrade / hardware change.
- NVIDIA MPS or MIG-based system-level isolation — RTX 2070 doesn't support
  MIG, and MPS is unnecessary complexity for a single-consumer-process
  machine.
- Chunking `propagate_in_video` into sub-ranges — not needed once the
  tracking-range cap (below) is in place; can be revisited later if the cap
  is raised.
- Changing the existing kill-and-restart recovery mechanism
  (`_restart_worker_process_after_track_failure` in `ml-worker/app/tasks.py`)
  — it already does the right thing for an in-process CUDA exception; this
  design just needs to make sure the failure it recovers from is a
  controlled Python exception, not an uncontrolled driver-level event.

## Design: three independent layers of defense

Each layer is useful alone but the combination is the point: layers 2-3 are
best-effort heuristics that reduce how often the danger zone is
approached; layer 1 is the hard backstop that makes it physically
impossible for the process to exceed a fixed VRAM budget, regardless of
whether the heuristics were accurate.

### Layer 1 — Hard per-process VRAM cap (the backstop)

At `ml-worker` process startup (before any CUDA allocation — the natural
place is early in `ml-worker/app/celery_app.py`, or a worker-init hook),
call:

```python
torch.cuda.set_per_process_memory_fraction(0.8)
```

0.8 of 8192 MiB ≈ 6554 MiB, leaving ≈1638 MiB for the desktop session —
satisfies the ~1.3-1.5 GiB headroom requirement with a small extra margin.

With this in place, PyTorch raises `torch.cuda.OutOfMemoryError` once the
process's own allocations would cross the fraction, instead of the
allocator continuing to grow until the driver/hardware itself is out of
memory. This converts the failure mode from "uncontrolled, possibly
driver-fatal" to "an ordinary Python exception the existing code already
knows how to handle."

The exact fraction is a tunable constant; 0.8 is the starting value based
on current desktop VRAM usage plus the requested margin, not derived from
a hard requirement — it may be revisited once real usage data accumulates.

### Layer 2 — Hard cap on tracking range

No sequence should be trackable in a single request beyond a bound proven
safe under Layer 1. Cap total `backward + forward` frames at **20**.

- **Backend** (`backend/app/jobs/schemas.py`, `Sam2TrackRequest`): add
  `Field(ge=0)` bounds on `backward`/`forward` individually, plus a model
  validator enforcing `backward + forward <= 20`. Reject with a clear
  validation error (HTTP 422) before the job is even enqueued.
- **Frontend** (`frontend/src/features/annotation/TrackControls.tsx`): set
  `max` on both number inputs such that their sum cannot exceed 20 (e.g.
  clamp the counterpart input when one changes), and cap the "Max" button's
  behavior at the same combined limit instead of the full available
  sequence segment. Show a short inline note explaining the cap exists for
  GPU memory safety.

This is a UX-level safety rail, not the primary defense — its job is to
stop obviously oversized requests before they cost a worker restart, not
to be the last line of defense against VRAM exhaustion.

### Layer 3 — Pre-flight VRAM estimate

Before calling `propagate_in_video` in `run_sam2_track` (and the
equivalent path in `run_sam3_track`), `ml-worker/app/tasks.py`:

1. Read current free VRAM via `torch.cuda.mem_get_info()`.
2. Estimate required VRAM with a simple heuristic:
   `frame_count * width * height * bytes_per_pixel_estimate * overhead_factor`.
   The `bytes_per_pixel_estimate * overhead_factor` constant is calibrated
   once empirically: run a known tracking range manually, read the actual
   `vram_used_bytes` already recorded by `_record_vram_usage`, and back out
   the per-pixel-per-frame cost. Store the calibrated constant next to the
   estimate function with a comment noting how it was derived.
3. If the estimate plus a safety margin exceeds free VRAM (bounded further
   by the Layer 1 fraction), fail the job immediately with a clear message
   ("insufficient GPU memory for requested range — try a smaller range")
   without touching the GPU predictor at all.

This estimate does not need to be precise — Layer 1 guarantees safety even
if it's wrong. Its purpose is purely to avoid burning a worker restart
cycle on requests that are obviously going to fail.

## Failure handling

When Layer 1's cap triggers, `torch.cuda.OutOfMemoryError` propagates up
through `track()` and must be caught by the same `except` blocks in
`run_sam2_track`/`run_sam3_track` that currently handle track failures —
i.e. `_clear_cuda_cache_on_error` context manager runs, the job is marked
`FAILED` with `job.error` set, and
`_restart_worker_process_after_track_failure()` performs the existing
`os._exit(1)` + container-restart recovery. This path already exists for
general exceptions; this design requires verifying (with a test) that
`torch.cuda.OutOfMemoryError` specifically is caught by it, not missed by a
narrower except clause.

## Testing strategy

Intentionally crashing the host to validate the fix is off the table. Two
complementary approaches:

1. **Empirical validation of Layer 1, without host risk**: temporarily set
   an artificially low `set_per_process_memory_fraction` (e.g. `0.05`) and
   run a real tracking job on a small range. This must reliably produce a
   controlled `torch.cuda.OutOfMemoryError`, get caught by the existing
   handler, mark the job `FAILED`, and have the worker process restart
   cleanly via `restart: unless-stopped` — proving the backstop mechanism
   and recovery path both work, without ever approaching real VRAM
   exhaustion.
2. **Unit tests for Layers 2 and 3**: schema/validator tests for the
   `backward + forward <= 20` bound (backend) and a range-clamping test for
   the frontend controls; a unit test for the pre-flight estimate function
   with `torch.cuda.mem_get_info` mocked, covering both the "enough memory"
   and "insufficient memory → job fails without calling track" cases.

## Open items for the implementation plan

- Exact location for the `set_per_process_memory_fraction` call (celery
  worker-process init hook vs. adapter lazy-init) — needs to run exactly
  once per process, early, before any tracking/predict call.
- Calibration constant for Layer 3's estimate — needs one manual
  measurement pass before the heuristic can be written with real numbers.
