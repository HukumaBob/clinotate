# Global app header design

Implements the "Top-level navigation" section of
[docs/specs/2026-07-23-platform-ui-ux-design.md](../../specs/2026-07-23-platform-ui-ux-design.md),
which specifies the six-section nav bar (`Media → Sequences → Tags →
Dataset → Train → Results`) but was never actually built — `App.tsx`
currently renders each page directly under its own `RequireAuth`, with no
shared layout or navigation chrome at all.

## Scope

Build the header shell now, wired to real routes only where routes exist.
Of the six sections, only **Media** (`/videos`) is a real route today.
**Sequences** has no catalog route yet — only
`/videos/:videoId/sequences/:sequenceId` for a specific sequence — so it is
treated as not-yet-available, same as Tags/Dataset/Train/Results.

## Components

- **`frontend/src/app/AppHeader.tsx`** — presentational component, no
  business logic beyond reading `useAuth` for the current user's email and
  the logout action.
- **`frontend/src/app/AppLayout.tsx`** — renders `<AppHeader />` above an
  `<Outlet />` (react-router). Replaces the current pattern of wrapping each
  page individually in `RequireAuth`; instead one `RequireAuth` wraps a
  single layout route, and every protected page becomes a nested route
  rendered through `Outlet`. This guarantees the header is visible on every
  protected screen, including the frame editor — which per the UI/UX spec
  is a full-viewport frame grid, but the spec only says the *grid* fills
  available width, not that the header must be hidden.

## Header layout

One horizontal bar, dark theme, `sticky top-0`, fixed height (~56px):

- **Left:** plain text platform name ("Endoscopy Annotation Platform"), not
  a link — `/videos` is already the only real landing page, so a redundant
  home link adds nothing yet.
- **Center-left:** the six nav items, in spec order, flat, no nested menus:
  - **Media** — a real `<Link to="/videos">`, visually highlighted when the
    current path matches.
  - **Sequences, Tags, Dataset, Train, Results** — rendered as `<span>`,
    not `<a>`/`<Link>`: muted text color, `cursor-not-allowed`, no href, no
    onClick. Visually reads as "coming soon" rather than broken.
- **Right:** current user's email (from `useAuth`) + a "Log out" button
  that calls the auth store's logout action and redirects to `/login`.

## Testing

Unit test for `AppHeader`:

- All six nav items render, in the spec's order.
- "Media" is a real link targeting `/videos`.
- The other five items have no `href` and no click handler.
- When authenticated, the user's email and a "Log out" control are shown.
- Clicking "Log out" calls the auth store's logout action.

## Out of scope

- Building the five missing screens/routes (Sequences catalog, Tags,
  Dataset, Train, Results) — those are separate, future pieces of work.
  This task only builds the header shell and wires up what already exists.
- Any visual polish beyond what the UI/UX spec already calls "not covered"
  (exact spacing/typography) — dark theme only, matching existing Tailwind
  config.
- Active-item highlighting logic beyond a simple current-path match for
  "Media" (no breadcrumbs, no multi-level active state — there's only one
  active route to highlight right now).
