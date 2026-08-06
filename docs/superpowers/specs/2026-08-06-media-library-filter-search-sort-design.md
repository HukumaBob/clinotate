# Media library: filter, search, sort, and pagination

Date: 2026-08-06
Status: approved, ready for implementation plan

## Problem

`GET /media/library` (`backend/app/media/router.py:131`) returns every video
and standalone-photo sequence in one unpaginated list. The table
(`frontend/src/features/media/MediaLibraryTable.tsx`) renders all of them
with no way to narrow or reorder the list. As the library grows this is
both slow to scan and (eventually) slow to render.

## Scope

Add to the media library table:
- A **Filename** search box in the column header — substring match against
  a video's `filename`/`title` or a photo sequence's `filename`.
- **Type** and **Procedure** single-select dropdowns in their column
  headers.
- Click-to-sort arrows on **Uploaded**, **Last edited**, **Size**, and
  **Sequences** column headers (single-column sort, ascending/descending).
- Page-number pagination at the bottom of the table.

Filename is search-only (no sort arrows). Type/Procedure are single-select
(no multi-select checkboxes). All of this is server-side: the backend
becomes the source of truth for filtering, sorting, and paging.

## API design

`GET /media/library` gains query parameters, all optional:

| Param | Type | Default | Notes |
|---|---|---|---|
| `search` | `str \| None` | `None` | Case-insensitive substring match. For videos: matches `filename` OR `title`. For photo sequences: matches `filename`. |
| `type` | `Literal["video", "photo"] \| None` | `None` | Filters to one `kind`. |
| `procedure_id` | `int \| None` | `None` | Filters to one procedure. |
| `sort` | `Literal["uploaded_at", "last_edited_at", "size_bytes", "linked_sequence_count"]` | `"uploaded_at"` | |
| `order` | `Literal["asc", "desc"]` | `"desc"` | |
| `page` | `int` | `1` | 1-indexed. |
| `page_size` | `int` | `25` | |

Response becomes a pagination envelope:

```python
class MediaLibraryPage(BaseModel):
    items: list[MediaLibraryItem]
    total: int
    page: int
    page_size: int
```

`MediaLibraryItem` itself is unchanged.

### Implementation approach

The current handler builds the full list in two Python loops (one for
videos, one for standalone photo sequences), each computing
`last_edited_at` per row via a subquery. That N+1-shaped construction stays
as-is — this is an internal platform, not library-scale data, and
`last_edited_at` is a derived value that doesn't map to a plain column,
so pushing search/sort/paging into SQL now would mean a non-trivial
rewrite (CTE or UNION over videos+sequences) for no near-term benefit.
Revisit only if the library grows large enough to matter.

New behavior applies to the already-assembled `list[MediaLibraryItem]`
in Python, in this order:
1. **Filter** by `search` (case-insensitive substring on the appropriate
   field per item), `type`, `procedure_id`.
2. **Sort** by the `sort` key, `reverse=(order == "desc")`.
3. **Paginate**: `total = len(filtered)`, slice
   `[(page-1)*page_size : page*page_size]`.

`page`/`page_size` are not validated beyond Pydantic's type coercion
(e.g. `page=0` or a huge `page` just yields an empty `items` slice) —
consistent with this being an internal tool, not a public API.

## Frontend design

### State

`MediaLibraryTable` owns: `search`, `type`, `procedureId`, `sort`, `order`,
`page`, `pageSize` (fixed at 25, no page-size selector in this pass).

- Changing `search`, `type`, or `procedureId` resets `page` to 1.
- The search input is debounced 300ms before it updates the query param,
  so typing doesn't fire a request per keystroke.
- Clicking a sortable column header: if it's already the active sort
  column, flips `order`; otherwise becomes the new `sort` column with
  `order` reset to `"desc"`. Resets `page` to 1.

### Data fetching

`useMediaLibrary` (`frontend/src/entities/useMediaLibrary.ts`) takes these
params and includes them in the React Query key, so each distinct
filter/sort/page combination is cached independently:

```ts
useMediaLibrary({ search, type, procedureId, sort, order, page, pageSize })
```

### Components

- Column headers for Type/Procedure render a `<select>` inline in the
  `<th>`, replacing the plain label — "All types" / "All procedures" as
  the empty-filter option.
- Filename header gets a text `<input>` inline in the `<th>`.
- Uploaded/Last edited/Size/Sequences headers become clickable buttons
  showing a ▲/▼ next to the label when they're the active sort column.
- A new `MediaLibraryPagination` component below the table: page numbers
  plus Previous/Next, driven by `total`/`page`/`page_size` from the
  response. Hidden entirely when `total <= page_size` (single page).

### Empty states

- No rows match the current filter/search: render a single-row "No media
  matches your filters" message instead of an empty `<tbody>`.
- Loading a new page/filter shows the existing table with a subtle loading
  state (reuse whatever loading treatment `MediaLibraryTable` already has
  for the initial load, if any — otherwise a simple text row).

## Testing

- Backend: parametrized tests on `get_media_library` covering each filter
  param alone, combinations, each sort key in both directions, and paging
  (page 1 / page 2 / out-of-range page / custom page_size).
- Frontend: `MediaLibraryTable.test.tsx` covers typing in the search box
  (debounced call), selecting Type/Procedure, clicking a sort header twice
  (asc then desc), and rendering `MediaLibraryPagination` with a
  multi-page response mocked from `useMediaLibrary`.

## Out of scope

- Multi-select filters (checkboxes) for Type/Procedure.
- Sorting by Filename.
- Configurable page size in the UI.
- Moving filter/sort/paging logic to SQL.
