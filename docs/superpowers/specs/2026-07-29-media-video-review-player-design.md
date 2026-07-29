# Media screen — video review player design

Extends [2026-07-28-media-screen-design.md](2026-07-28-media-screen-design.md)
after real usage of the shipped Media screen surfaced a gap: uploading a
video gives no way to actually *see* it before cutting a `Sequence` out of
it, and there is no way to return to an already-uploaded video to cut a
second `Sequence` from a different time range. Both gaps matter for this
platform's real workflow: one source video commonly gets split into
several `Sequence`s for different anatomical segments of the same
procedure (larynx, esophagus, stomach, duodenum), cut one at a time,
returning to the same video each time.

## Scope

In scope: a video review/scrub player reachable from the Media screen's
library table, a timeline showing already-cut `Sequence`s as colored
segments, marking a new segment's start/end from the player, and
server-side codec compatibility detection with an on-demand transcode to
a browser-playable format. Out of scope: editing or deleting an existing
`Sequence`'s time range from the timeline (only creating new ones);
transcoding photo-batch sequences (they have no source video); any
change to the Photos → Sequence upload flow.

## User flow

1. User clicks a video row in the Media library table (any row where
   `kind === "video"`).
2. The two upload forms (video upload, photo batch) are replaced in place
   by `VideoReviewPlayer` for that video. A "← Upload another video"
   button returns to the two forms.
3. If the video is browser-playable, the player loads and plays normally.
   If not, a placeholder explains this and offers a "Convert video"
   button (see Codec compatibility below).
4. User scrubs/plays the video, clicks "Mark start" at the desired point,
   continues to the desired end point, clicks "Mark end". A compact
   sequence-creation form appears below the marks (Name, Procedure, FPS,
   collapsed crop box — the same fields `ExtractSequenceForm` already
   has), with Start/Duration silently derived from the two marks instead
   of typed in.
5. Submitting creates the `Sequence` (`POST /media/videos/{id}/sequences`,
   unchanged endpoint). The user **stays on the same video's player**: the
   timeline immediately shows the new segment, the marks and form reset,
   and the user can mark another range right away. Each timeline segment
   has its own "Open" affordance to navigate into that `Sequence`'s grid
   (`/sequences/:id`) when the user is done cutting from this video.

## Frontend

### `VideoReviewPlayer.tsx` (new, `frontend/src/features/media/`)

Props: `videoId: number`, `onBack: () => void` (returns to the upload
forms).

- Fetches `VideoRead` (existing `useVideo`/equivalent) and the video's
  `Sequence[]` (existing `GET /media/videos/{id}/sequences`, already used
  elsewhere) via TanStack Query, refetching the sequence list after every
  successful creation (same `["media-library"]`-style invalidation
  pattern already used by the other mutations).
- If `video.browser_playable === false`: renders `TranscodePrompt`
  instead of `<video>` (see below).
- If `video.browser_playable === true` (or `null`, meaning the ffprobe
  check hasn't run yet — treat as playable and let the native `<video>`
  fail closed with its own `onError`, which flips a local "show transcode
  prompt anyway" flag; this handles the edge case of a pre-existing
  `Video` row from before this feature shipped, where `browser_playable`
  was never computed): renders a native `<video controls>` element (no
  custom playback chrome — only the timeline below it is custom) plus
  `SequenceTimeline`.

### `SequenceTimeline.tsx` (new)

Props: `durationSeconds: number`, `sequences: SequenceRead[]`,
`onMarkStart: () => void`, `onMarkEnd: () => void`, `markStart: number |
null`, `markEnd: number | null`, `onOpenSequence: (id: number) => void`.

- A full-width bar; each existing `Sequence` renders as a colored segment
  positioned/sized by `start_time`/`duration` as a percentage of
  `durationSeconds`, with the sequence's `name` as text inside the segment
  (truncated with "…" if the segment is too narrow to fit it, full name
  via `title` attribute — same truncation pattern already used for long
  values in `MediaLibraryTable`). Segment colors cycle through a small
  fixed palette keyed by `sequence.id % N`, no per-procedure color
  mapping (procedures aren't guaranteed a stable color story elsewhere in
  the app yet — out of scope to invent one here).
- A small "Open" button/icon appears on each segment (hover or
  always-visible compact icon — implementer's call during execution,
  not load-bearing) calling `onOpenSequence(sequence.id)`, which the
  parent wires to `navigate(`/sequences/${id}`)`.
- The in-progress mark range (if `markStart`/`markEnd` are set) renders as
  a distinct outline/hatch style overlay, visually different from
  committed segments, so the user can see what they're about to submit
  before it exists.
- Two buttons above or below the bar: "Mark start" / "Mark end", disabled
  until the player has a valid `currentTime` (i.e., video metadata
  loaded). Clicking either reads `videoRef.current.currentTime` from the
  parent (passed down or lifted — implementer's call) and calls
  `onMarkStart`/`onMarkEnd`. No drag-to-resize interaction — two discrete
  clicks only, per this design's explicit scope.

### `SequenceFromMarksForm.tsx` (new, or inlined into `VideoReviewPlayer`)

Appears once both `markStart` and `markEnd` are set (and `markEnd >
markStart`; if the user marks end before start or marks the same point
twice, show an inline validation message instead of the form — no
crash). Fields: `Name` (via existing `useSuggestSequenceName`, editable),
`Procedure` (select), `FPS`, collapsed crop box — visually and logically
the same fields `ExtractSequenceForm` already renders. Reuse
`ExtractSequenceForm`'s field-level pieces directly if the implementer
finds a clean extraction; duplicating the four crop inputs once more
rather than forcing an awkward shared abstraction is also acceptable —
implementer's call, not load-bearing for this design.

Submitting calls the existing `useCreateSequenceFromVideo` mutation with
`startTime = markStart`, `duration = markEnd - markStart` (rounded to
whole seconds, matching the existing `start_time`/`duration: int` backend
fields — no new precision requirement introduced here). On success:
`markStart`/`markEnd` reset to `null`, the form's fields reset, the
sequence list refetches (new segment appears on the timeline). The parent
does **not** navigate away.

### `TranscodePrompt.tsx` (new)

Props: `videoId: number`.

- Default state: explanatory text ("This video's format isn't supported
  by the browser player.") + a "Convert video" button.
- On click: `POST /media/videos/{id}/transcode` (see backend below),
  creating a `Job`. Switches to a progress view reusing the existing
  job-polling pattern already used for SAM predict/track jobs (poll
  `GET /jobs/{id}`, show `progress`/`status`).
- On `Job.status === "succeeded"`: the parent (`VideoReviewPlayer`)
  refetches the `Video` row (now `browser_playable: true`, new
  `storage_key`) and swaps to the real player automatically — no manual
  "reload" click needed.
- On `Job.status === "failed"`: shows the job's `error` message and lets
  the user retry (re-clicking "Convert video" creates a fresh `Job`).

### Hooks (`frontend/src/entities/`)

- `useVideoSequences(videoId)` if no equivalent already exists cleanly
  reusable — check before adding; `SequenceGridPage`'s existing data
  fetching may already cover this shape.
- `useTranscodeVideo()` — mutation for `POST
  /media/videos/{id}/transcode`, returns the created `Job`.
- `useJob(jobId)` — if a generic job-polling hook doesn't already exist
  from the SAM predict/track UI, add one; if it does, reuse it as-is
  rather than writing a Media-specific duplicate.

## Backend

### Data model changes (`app/media/models.py`)

`Video` gains three nullable fields, populated by the ffprobe check
described below (`null` = not yet checked, which should not occur for any
row created after this ships, but must be handled gracefully for rows
from before it — see the frontend's `browser_playable === null` handling
above):

- `browser_playable: bool | None`
- `container: str | None` (e.g. `"mp4"`, `"webm"`, `"avi"` — the format
  name ffprobe reports)
- `video_codec: str | None` (e.g. `"h264"`, `"hevc"`, `"mpeg4"` — the
  codec name ffprobe reports)

`container`/`video_codec` exist for operator debugging only (e.g. "why did
this get flagged as unplayable") — no UI surfaces them directly.

### Codec check at upload time (`app/media/service.py` / `router.py`)

`POST /media/videos` (existing endpoint), after the uploaded bytes are
written to a temp file (the existing OpenCV-needs-a-real-path pattern
`media/service.py` already uses) and before/alongside the existing
`StorageService` upload: run `ffprobe -v error -select_streams v:0
-show_entries stream=codec_name -show_entries format=format_name -of
json` (subprocess call, not a new Python dependency — `ffmpeg`/`ffprobe`
must already be present in the backend image if `extract_frames`' OpenCV
video decoding works at all in Docker; verify during implementation, add
to the Dockerfile if missing) against the temp file. Parse `format_name`
and the video stream's `codec_name`.

`browser_playable = container in {"mp4", "mov,mp4,m4a,3gp,3g2,mj2"} and
video_codec == "h264"` — an explicit whitelist, not a blocklist, since a
false negative (flagging a playable video as unplayable) only costs the
user one unnecessary transcode, while a false positive (flagging an
unplayable video as fine) means a silent black-screen player with no
guidance. The exact ffprobe `format_name` string for a standard MP4
container needs confirming during implementation (it's commonly the
comma-joined `"mov,mp4,m4a,3gp,3g2,mj2"` — verify against a real ffprobe
run rather than assuming).

This runs synchronously inside the upload request (ffprobe on a container
header is fast, no full-file decode) — no `Job` is created for the check
itself, only for the optional transcode.

### `POST /media/videos/{video_id}/transcode` (new endpoint)

- 404 if the video doesn't exist.
- 409 if `browser_playable` is already `true` (nothing to do) or if a
  `VIDEO_TRANSCODE` job for this video is already `pending`/`running`
  (avoid duplicate concurrent transcodes of the same file).
- Otherwise creates `Job(job_type=VIDEO_TRANSCODE, payload={"video_id":
  video_id}, created_by_id=current_user.id)`, returns `JobRead` — same
  response shape the SAM predict/track endpoints already return, so the
  frontend's existing job-polling UI pattern applies unchanged.

### `JobType.VIDEO_TRANSCODE` (extend `app/jobs/models.py`'s existing enum)

No new table. `Job.payload = {"video_id": <id>}`, `Job.result_ref` is set
to the new MinIO `storage_key` on success (matching how other job types
already use `result_ref`).

### New backend Celery worker (`backend/app/worker/`, new)

A second Celery worker process, separate from `ml-worker`'s GPU container
— this is a CPU-only `ffmpeg` transcode, it must not compete for a GPU
slot or share `ml-worker`'s deployment lifecycle. Runs against the same
Redis broker `ml-worker` already uses; a **dedicated queue name** (e.g.
`transcode`, distinct from whatever queue name the SAM tasks use) so a
transcode job can never block behind a GPU job or vice versa. Add a new
service to `docker-compose.yml` (e.g. `backend-worker`) built from the
existing `backend` image (same dependencies, ffmpeg already needed there
per the codec-check note above) running `celery -A app.worker worker -Q
transcode`.

Task `transcode_video(job_id: int)`:
1. Load the `Job` and its `payload["video_id"]`'s `Video` row.
2. Set `Job.status = RUNNING`, `started_at = now()`.
3. Download the source file from `StorageService`, run `ffmpeg -i
   <source> -c:v libx264 -preset medium -c:a aac -movflags +faststart
   <output.mp4>` (exact flags are an implementation detail the
   implementer should verify against a real problematic sample file
   during execution — the requirement is "produces an MP4/H.264 file a
   browser `<video>` element can play," not these exact flags).
4. Report progress via `Job.progress` if `ffmpeg`'s stderr progress
   output is reasonably parseable within the task's time budget;
   otherwise a coarse two-step progress (0 → 100 on completion) is
   acceptable — this is a UX nicety, not a hard requirement, since most
   source videos here are short.
5. Upload the transcoded file via `StorageService`, get its new
   `storage_key`.
6. Update `Video.storage_key`, `Video.browser_playable = True`,
   `Video.container`/`video_codec` to the new file's values (or hardcode
   `"mp4"`/`"h264"` since that's what step 3 always produces).
7. Set `Job.status = SUCCEEDED`, `result_ref = new storage_key`,
   `finished_at = now()`.
8. On any exception: `Job.status = FAILED`, `error = str(exception)`,
   `finished_at = now()` — the video's `storage_key` is left untouched
   (never partially overwritten), so a failed transcode never corrupts
   the existing (unplayable-in-browser but still-valid) source file.

**The transcode replaces `Video.storage_key` in place rather than
creating a new `Video` row** — existing `Sequence` rows already
referencing this `video_id` (if any were somehow created despite
`browser_playable=false`, which shouldn't normally happen since the
player wouldn't have been usable, but is not itself invalid data) keep
working unchanged, and the Media library table's row count stays
accurate.

## Error handling

- ffprobe itself fails to run (corrupt upload, unsupported container
  ffprobe can't even parse) → `browser_playable = False`,
  `container`/`video_codec = None` — treated the same as "needs
  transcode," not a separate upload-time error; the user still gets their
  video uploaded and can attempt a transcode, which will itself fail
  clearly (via the `Job.error` path) if the file is genuinely unusable.
- Marking end before start, or marking the same timestamp twice → inline
  validation message in `VideoReviewPlayer`, no request sent.
- Transcode job fails → `TranscodePrompt` shows the error and allows retry
  (new `Job`), never leaves the user stuck with no path forward.
- Duplicate transcode request while one is already running → backend 409,
  surfaced as "A conversion is already in progress" rather than silently
  queuing a second one.

## Testing

TDD per `CLAUDE.md`, both sides.

**Backend (pytest):**
- Upload a video with a known-playable container/codec (the existing
  `tiny.mp4` fixture) → `browser_playable == True` after upload.
- ffprobe codec-detection logic tested directly against at least one
  fixture ffprobe would classify as NOT browser-playable (implementer
  needs a second small fixture file in a non-H.264 codec/container —
  check whether one already exists under `backend/tests/fixtures/` or add
  one; do not skip this case by mocking ffprobe's output only, since the
  actual parsing of real ffprobe JSON output is exactly what needs
  coverage).
- `POST /media/videos/{id}/transcode`: creates a `Job` with the right
  `job_type`/`payload`; 409 when already playable; 409 when a
  pending/running transcode job already exists for that video; 404 for a
  missing video.
- `transcode_video` task (can run outside Celery in the test, calling the
  task function directly per this repo's existing pattern for testing
  Celery task bodies, if one exists — check `ml-worker`'s test setup for
  the established pattern): source video → `Job` ends `SUCCEEDED`,
  `Video.storage_key` changed, `Video.browser_playable == True`; a
  forced-failure path (e.g. missing source file) → `Job` ends `FAILED`
  with a non-empty `error`, `Video.storage_key` unchanged.

**Frontend:**
- `SequenceTimeline`: renders segments at correct positions/widths for
  given `duration`/`sequences`; renders the in-progress mark overlay when
  both marks are set; does not render it when only one or neither is set.
- `VideoReviewPlayer`: mark-start/mark-end button wiring updates local
  state from a mocked `currentTime`; submitting the derived form calls
  the create-sequence mutation with the expected `start_time`/`duration`;
  after a successful creation, marks reset and the sequence list refetch
  is triggered (assert the query invalidation, not a full re-render
  round-trip).
- `TranscodePrompt`: renders the convert button in the default state;
  after clicking, polls the job and renders progress; on `succeeded`,
  calls its parent's refetch callback; on `failed`, shows the error and
  re-enables the convert button.
- One real-browser Playwright e2e extending `annotation-flow.spec.ts`:
  upload a video, click its library row, mark a start and end point on
  the timeline, submit, assert the new segment appears on the timeline
  with the expected name and stays on the player (URL unchanged) rather
  than navigating away. A transcode-path e2e scenario is not required
  (would need a real non-playable fixture video and a real ffmpeg run in
  CI/local — the unit-level `transcode_video` task test plus manual
  verification during this repo's mandatory real-browser check before
  claiming the feature works covers this adequately).

## Deviations from the prior Media screen design

- The original design's `ExtractSequenceForm` (typed Start/Duration
  fields) remains as-is for now — this design adds a second entry point
  (`SequenceFromMarksForm`, driven by timeline marks instead of typed
  values) for the "return to an already-uploaded video" flow, rather than
  replacing the first-upload flow's form. Both forms call the same
  `useCreateSequenceFromVideo` mutation; no backend duplication. Whether
  the original `VideoUploadFlow`'s post-upload step should also switch to
  the marks-based UI (folding the two entry points into one) is an open
  question left for a future iteration, not decided here — out of scope
  for this design, which is scoped to enabling the return-to-video flow
  the original design didn't support at all.
