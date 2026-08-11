# Settings Page Design

**Context:** the SAM2 GPU OOM host-crash prevention plan
(`docs/superpowers/specs/2026-08-08-sam2-gpu-oom-host-crash-design.md`)
hardcoded a 20-combined-frame tracking-range cap
(`MAX_TRACK_RANGE_FRAMES` in `backend/app/jobs/schemas.py`). On 2026-08-09,
Track requests at and near that cap repeatedly hard-rebooted the dev host
even with every software mitigation from that plan applied (see
`project_sam2_vram_crash_open_issue` memory) — root cause is unresolved.
Until it's found, the working mitigation is to run with a much more
conservative cap (10 combined frames) and make it adjustable without a
redeploy, since the safe value is still being determined empirically.

This also establishes the platform's first genuinely global,
admin-controlled runtime setting — there was no such concept before this.

## Backend

**New module** `backend/app/settings/` (models.py, schemas.py, service.py,
router.py), following the existing per-domain module layout (`jobs/`,
`media/`, `taxonomy/`).

**Table** `platform_settings` — a singleton row (`id` fixed at `1`,
enforced by only ever reading/writing that id, no multi-tenancy concept
exists in this platform):
- `max_track_range_frames: int`, default `10`

A migration seeds the single row with the default on creation.

**Endpoints:**
- `GET /settings` → `SettingsRead { max_track_range_frames: int }`.
  Available to any authenticated user — `TrackControls` needs to read this
  regardless of the viewer's role.
- `PATCH /settings` → same shape, requires `role == UserRole.ADMIN`
  (checked inline in the router the same way
  `backend/app/annotation/service.py:31` already does — no new
  `require_admin` dependency abstraction is introduced for a single call
  site). Non-admins get 403. Validates `max_track_range_frames >= 1`
  (`Field(ge=1)`), same floor already implied by `Sam2TrackRequest`'s
  existing `backward`/`forward` `Field(ge=0)` pair.

**`Sam2TrackRequest` changes** (`backend/app/jobs/schemas.py`): the
`_validate_combined_range` model validator stops reading the module-level
`MAX_TRACK_RANGE_FRAMES = 20` constant and instead reads the live
`platform_settings.max_track_range_frames` value at validation time via
the settings service. The constant and its docstring comment are removed;
the design-doc cross-reference comment moves to the settings module.

## Frontend

**Navigation:** `AppHeader.tsx` gains a gear icon between the user email
and the Log out button, rendered only when `user.role === "admin"` —
fully absent (not shown-disabled) for other roles; see Deviations below
for why this deliberately does not follow the existing disabled-label
pattern used for not-yet-built nav sections. Clicking navigates to
`/settings`.

**Route:** `/settings` → `SettingsPage.tsx` in a new
`frontend/src/features/settings/` directory, added to `App.tsx` inside
the existing `RequireAuth` wrapper. No separate admin-only route guard is
added beyond the nav icon's visibility — a non-admin who navigates to
`/settings` directly sees the page's read-only `GET /settings` value (the
endpoint doesn't require admin) but the Save action fails with the same
403 the backend returns, surfaced via the existing inline-error pattern.

**Page contents:**
- Heading "Settings"
- A "GPU / Performance" section containing one field: number input
  labeled "Max SAM2 tracking range (combined frames)", pre-filled from
  `GET /settings` (via a `useQuery`, following this codebase's existing
  TanStack Query usage)
- One line of static help text under the field: this GPU has a known VRAM
  stability issue at larger tracking ranges; lower is safer. No link to
  the internal incident doc — that's implementation history, not
  user-facing content.
- A "Save" button, wired to a `useMutation` PATCH call. On error, the
  detail message renders inline below the button (same pattern as
  `SequenceForm.tsx`'s `deleteError` state — a local `useState<string |
  null>`, populated in `onError`, cleared before each submit attempt). No
  toast component exists in this codebase; none is introduced here.

**`TrackControls.tsx` changes:** the hardcoded
`MAX_COMBINED_TRACK_RANGE = 20` constant is replaced by the value from a
`useQuery(['settings'])` call (the same query key/cache entry the
Settings page's read populates, so editing the value on `/settings` and
returning to the frame editor reflects the new cap without a manual
refetch, once TanStack Query's cache invalidation on the PATCH mutation's
`onSuccess` is wired). While the query is loading, the existing
`maxBackward`/`maxForward` props' behavior falls back to *no combined cap
applied yet* (budget clamp skipped) rather than blocking the whole
control — Track range inputs render immediately using only the
per-sequence bounds, and re-clamp once the settings value arrives. This
avoids adding a loading spinner to a control that already renders
instantly today.

## Testing

Backend: TDD per `CLAUDE.md` — failing test first for `GET`/`PATCH
/settings` (including the 403-for-non-admin case), and for
`Sam2TrackRequest` picking up a changed `max_track_range_frames` value
instead of the removed constant.

Frontend: `SettingsPage.test.tsx` covering the load/edit/save/error
states; `TrackControls.test.tsx` gains a case asserting the combined-range
cap follows the mocked settings value rather than a hardcoded `20`.

## Deviations considered during this design

The nav-icon visibility description above initially claimed parity with
"how not-yet-built sections are shown" — checked against
`AppHeader.tsx`'s actual `NAV_ITEMS`: unbuilt sections (Tags/Dataset/
Train/Results) render as a disabled *greyed-out label*, not an absent
element. The Settings gear icon deliberately does NOT follow that
pattern — it's fully absent for non-admins, not shown-disabled, because
unlike an unbuilt section (temporary, same for everyone), a non-admin
permanently cannot use Settings regardless of build status, and showing a
disabled gear would incorrectly suggest "coming soon" rather than
"not for your role."
