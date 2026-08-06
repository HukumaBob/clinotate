# Sequence Grid Thumbnail Labels and Mask Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `/sequences/:id`'s frame grid, replace bare `label <id>` thumbnail captions with resolved label name + color, and overlay each mask annotation's `mask_url` as a colored, semi-transparent layer on the thumbnail image.

**Architecture:** `SequenceGridPage` fetches the sequence (for `procedure_id`) and the taxonomy tree once, passing the tree down as a prop to every `FrameThumbnail`. A new pure helper `resolveLabelFromTree` (extracted from `MasksList`'s existing local closure) resolves a `label_id` to `{categoryName, tag, classification}` in both components. Mask overlays use CSS `mask-image` with `mask-mode: luminance` directly on the stored grayscale PNG — no canvas decoding, no `ImageData` cache, unlike the full frame editor's `FrameCanvas.tsx`.

**Tech Stack:** React, TypeScript, TanStack Query, Vitest + Testing Library, Tailwind (dark theme only).

## Global Constraints

- Language: English only in code, comments, docstrings, UI copy — no Russian in committed content.
- UI theme: dark only — don't introduce light-background classes.
- API contract: use `apiClient` from `frontend/src/shared/api/client.ts`; never hand-roll `fetch()`. Don't hand-edit `frontend/src/shared/api/generated/`.
- TDD: every task below writes a failing test before the implementation.
- `taxonomy_version` semantics are not touched by this feature (read-only label display), so no copy/versioning logic is needed here.

---

## Task 1: Extract `resolveLabelFromTree` shared helper

**Files:**
- Create: `frontend/src/features/annotation/resolveLabel.ts`
- Create: `frontend/src/features/annotation/resolveLabel.test.ts`
- Modify: `frontend/src/features/annotation/MasksList.tsx:35-50` (remove local `resolveLabel`, import shared helper)

**Interfaces:**
- Produces: `resolveLabelFromTree(tree: components["schemas"]["TaxonomyTreeNode"][], labelId: number): ResolvedLabel | null` where
  ```ts
  export interface ResolvedLabel {
    categoryId: number;
    categoryName: string;
    tag: components["schemas"]["LabelRead"];
    classification: number;
  }
  ```
- Consumes (Task 1): `components["schemas"]["TaxonomyTreeNode"]` from `frontend/src/shared/api/generated/schema.d.ts` — shape is `{ category: {id, name, procedure_id}, evaluation_types: [{ evaluation_type: {id, name}, labels: [{id, name, color, category_id}] }] }`.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/annotation/resolveLabel.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { resolveLabelFromTree } from "./resolveLabel";
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

function buildTree(): TaxonomyTreeNode[] {
  return [
    {
      category: { id: 1, name: "Polyp", procedure_id: 1 },
      evaluation_types: [
        {
          evaluation_type: { id: 10, name: "Morphology" },
          labels: [
            { id: 100, name: "Sessile", color: "#ff0000", category_id: 1 },
            { id: 101, name: "Pedunculated", color: "#00ff00", category_id: 1 },
          ],
        },
      ],
    },
    {
      category: { id: 2, name: "Bleeding", procedure_id: 1 },
      evaluation_types: [
        {
          evaluation_type: { id: 20, name: "Severity" },
          labels: [{ id: 200, name: "Active", color: "#0000ff", category_id: 2 }],
        },
      ],
    },
  ];
}

describe("resolveLabelFromTree", () => {
  it("resolves a label nested under the first category/evaluation type", () => {
    const result = resolveLabelFromTree(buildTree(), 100);
    expect(result).toEqual({
      categoryId: 1,
      categoryName: "Polyp",
      tag: { id: 100, name: "Sessile", color: "#ff0000", category_id: 1 },
      classification: 10,
    });
  });

  it("resolves a label nested under a later category", () => {
    const result = resolveLabelFromTree(buildTree(), 200);
    expect(result).toEqual({
      categoryId: 2,
      categoryName: "Bleeding",
      tag: { id: 200, name: "Active", color: "#0000ff", category_id: 2 },
      classification: 20,
    });
  });

  it("returns null when the label id is not present anywhere in the tree", () => {
    expect(resolveLabelFromTree(buildTree(), 999)).toBeNull();
  });

  it("returns null for an empty tree", () => {
    expect(resolveLabelFromTree([], 100)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/annotation/resolveLabel.test.ts`
Expected: FAIL — `resolveLabel.ts` does not exist / `resolveLabelFromTree` is not exported.

- [ ] **Step 3: Write minimal implementation**

Create `frontend/src/features/annotation/resolveLabel.ts`:

```ts
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];
type LabelRead = components["schemas"]["LabelRead"];

export interface ResolvedLabel {
  categoryId: number;
  categoryName: string;
  tag: LabelRead;
  classification: number;
}

export function resolveLabelFromTree(tree: TaxonomyTreeNode[], labelId: number): ResolvedLabel | null {
  for (const categoryNode of tree) {
    for (const evaluationTypeNode of categoryNode.evaluation_types) {
      const label = evaluationTypeNode.labels.find((l) => l.id === labelId);
      if (label) {
        return {
          categoryId: categoryNode.category.id,
          categoryName: categoryNode.category.name,
          tag: label,
          classification: evaluationTypeNode.evaluation_type.id,
        };
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/annotation/resolveLabel.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Replace `MasksList`'s local `resolveLabel` with the shared helper**

In `frontend/src/features/annotation/MasksList.tsx`:
- Remove the local `function resolveLabel(labelId: number) { ... }` block (lines 35-50).
- Add import: `import { resolveLabelFromTree } from "./resolveLabel";`
- Replace both call sites (`resolveLabel(annotation.label_id)` in `handleSelect` and in the render loop) with `resolveLabelFromTree(tree, annotation.label_id)`.

- [ ] **Step 6: Run the existing MasksList tests (if any) and the full annotation test suite to confirm no regression**

Run: `cd frontend && npx vitest run src/features/annotation`
Expected: PASS — no test currently covers `MasksList` directly, but this confirms nothing else in the directory broke (e.g. import errors).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/annotation/resolveLabel.ts frontend/src/features/annotation/resolveLabel.test.ts frontend/src/features/annotation/MasksList.tsx
git commit -m "refactor: extract resolveLabelFromTree as a shared taxonomy helper"
```

---

## Task 2: `FrameThumbnail` renders resolved label name + color

**Files:**
- Modify: `frontend/src/features/annotation/FrameThumbnail.tsx`
- Create: `frontend/src/features/annotation/FrameThumbnail.test.tsx`

**Interfaces:**
- Consumes (from Task 1): `resolveLabelFromTree(tree, labelId): ResolvedLabel | null` from `./resolveLabel`.
- Consumes (existing): `useAnnotations(frameId)` from `../../entities/useAnnotations`, returning `components["schemas"]["AnnotationRead"][]` (`{id, frame_id, label_id, taxonomy_version, annotation_type, status, created_by_id, reviewed_by_id, mask_url, job_id}`).
- Produces: `FrameThumbnail` now takes an additional required prop `taxonomyTree: components["schemas"]["TaxonomyTreeNode"][]`, consumed by Task 4 (`SequenceGridPage`).

This task covers the text-caption half only; Task 3 adds the mask overlay to the same component.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/annotation/FrameThumbnail.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { FrameThumbnail } from "./FrameThumbnail";
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const TAXONOMY_TREE: TaxonomyTreeNode[] = [
  {
    category: { id: 1, name: "Polyp", procedure_id: 1 },
    evaluation_types: [
      {
        evaluation_type: { id: 10, name: "Morphology" },
        labels: [{ id: 100, name: "Sessile", color: "#ff0000", category_id: 1 }],
      },
    ],
  },
];

describe("FrameThumbnail", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders the resolved category/label name instead of a bare label id", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 1,
          frame_id: 5,
          label_id: 100,
          taxonomy_version: 1,
          annotation_type: "mask",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: null,
          job_id: null,
        },
      ],
      error: undefined,
    } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    expect(await screen.findByText("Polyp / Sessile")).toBeInTheDocument();
  });

  it("falls back to 'label <id>' when the label isn't in the taxonomy tree", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 1,
          frame_id: 5,
          label_id: 999,
          taxonomy_version: 1,
          annotation_type: "mask",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: null,
          job_id: null,
        },
      ],
      error: undefined,
    } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    expect(await screen.findByText("label 999")).toBeInTheDocument();
  });

  it("renders no caption bar when there are no annotations", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({ data: [], error: undefined } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    await screen.findByAltText("Frame 5");
    expect(screen.queryByText(/label/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/annotation/FrameThumbnail.test.tsx`
Expected: FAIL — `taxonomyTree` prop not accepted / text still reads `● label 100`.

- [ ] **Step 3: Write minimal implementation**

Replace `frontend/src/features/annotation/FrameThumbnail.tsx` with:

```tsx
import { useAnnotations } from "../../entities/useAnnotations";
import { resolveLabelFromTree } from "./resolveLabel";
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

interface FrameThumbnailProps {
  frameId: number;
  imageUrl: string;
  taxonomyTree: TaxonomyTreeNode[];
  onClick: () => void;
}

export function FrameThumbnail({ frameId, imageUrl, taxonomyTree, onClick }: FrameThumbnailProps) {
  const annotationsQuery = useAnnotations(frameId);
  const annotations = annotationsQuery.data ?? [];

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative aspect-square overflow-hidden rounded border border-gray-800 bg-gray-900"
    >
      <img src={imageUrl} alt={`Frame ${frameId}`} className="h-full w-full object-contain" />
      {annotations.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex flex-wrap gap-1 truncate bg-gray-950/80 px-1 py-0.5 text-xs text-gray-200">
          {annotations.map((annotation) => {
            const resolved = resolveLabelFromTree(taxonomyTree, annotation.label_id);
            const label = resolved ? `${resolved.categoryName} / ${resolved.tag.name}` : `label ${annotation.label_id}`;
            const color = resolved?.tag.color ?? "#666";
            return (
              <span key={annotation.id} className="flex items-center gap-1">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </span>
            );
          })}
        </div>
      )}
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/annotation/FrameThumbnail.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/FrameThumbnail.tsx frontend/src/features/annotation/FrameThumbnail.test.tsx
git commit -m "feat: resolve label name and color on sequence grid thumbnails"
```

Note: this commit temporarily breaks `SequenceGridPage`'s call site (`taxonomyTree` prop now required but not yet passed) — that's fixed in Task 4. If your test runner also builds the whole app (`npm run build`), expect a TS error on `SequenceGridPage.tsx` between this task and Task 4; that's expected transient breakage within the same plan, resolved two tasks later. If you're running tasks in strict isolation with a build check between every task, do Task 4's `SequenceGridPage` edit as part of this task's Step 5 instead of leaving it broken — the two files are that tightly coupled.

---

## Task 3: `FrameThumbnail` renders CSS mask overlay for mask annotations

**Files:**
- Modify: `frontend/src/features/annotation/FrameThumbnail.tsx`
- Modify: `frontend/src/features/annotation/FrameThumbnail.test.tsx`

**Interfaces:**
- Consumes: `AnnotationRead.mask_url: string | null` and `AnnotationRead.annotation_type: "mask" | "bbox"` (existing schema fields, see `backend/app/annotation/schemas.py`).
- No new exports — this extends `FrameThumbnail`'s existing render output with overlay `div`s identified in tests via `data-testid="mask-overlay"`.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/features/annotation/FrameThumbnail.test.tsx` (inside the existing `describe` block):

```tsx
  it("renders a mask overlay div for each mask annotation with a mask_url, tinted by its label color", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 1,
          frame_id: 5,
          label_id: 100,
          taxonomy_version: 1,
          annotation_type: "mask",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: "http://example.com/mask-1.png",
          job_id: null,
        },
      ],
      error: undefined,
    } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    const overlays = await screen.findAllByTestId("mask-overlay");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]).toHaveStyle({ backgroundColor: "#ff0000" });
    expect(overlays[0].style.maskImage).toContain("http://example.com/mask-1.png");
  });

  it("renders one overlay div per mask annotation when a frame has multiple masks", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 1,
          frame_id: 5,
          label_id: 100,
          taxonomy_version: 1,
          annotation_type: "mask",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: "http://example.com/mask-1.png",
          job_id: null,
        },
        {
          id: 2,
          frame_id: 5,
          label_id: 999,
          taxonomy_version: 1,
          annotation_type: "mask",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: "http://example.com/mask-2.png",
          job_id: null,
        },
      ],
      error: undefined,
    } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    const overlays = await screen.findAllByTestId("mask-overlay");
    expect(overlays).toHaveLength(2);
  });

  it("does not render an overlay for annotations without a mask_url (e.g. bbox)", async () => {
    vi.mocked(apiClient.GET).mockResolvedValue({
      data: [
        {
          id: 1,
          frame_id: 5,
          label_id: 100,
          taxonomy_version: 1,
          annotation_type: "bbox",
          status: "pending",
          created_by_id: 1,
          reviewed_by_id: null,
          mask_url: null,
          job_id: null,
        },
      ],
      error: undefined,
    } as never);

    render(
      <FrameThumbnail frameId={5} imageUrl="http://example.com/frame.png" taxonomyTree={TAXONOMY_TREE} onClick={() => {}} />,
      { wrapper },
    );

    await screen.findByText("Polyp / Sessile");
    expect(screen.queryByTestId("mask-overlay")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/annotation/FrameThumbnail.test.tsx`
Expected: FAIL — no `mask-overlay` testid rendered yet.

- [ ] **Step 3: Write minimal implementation**

Modify `frontend/src/features/annotation/FrameThumbnail.tsx` — add a `DEFAULT_MASK_COLOR` constant and render one overlay `div` per mask annotation, placed between the `<img>` and the caption bar:

```tsx
import { useAnnotations } from "../../entities/useAnnotations";
import { resolveLabelFromTree } from "./resolveLabel";
import type { components } from "../../shared/api/generated/schema";

type TaxonomyTreeNode = components["schemas"]["TaxonomyTreeNode"];

const DEFAULT_MASK_COLOR = "#22d3ee";

interface FrameThumbnailProps {
  frameId: number;
  imageUrl: string;
  taxonomyTree: TaxonomyTreeNode[];
  onClick: () => void;
}

export function FrameThumbnail({ frameId, imageUrl, taxonomyTree, onClick }: FrameThumbnailProps) {
  const annotationsQuery = useAnnotations(frameId);
  const annotations = annotationsQuery.data ?? [];
  const maskAnnotations = annotations.filter((annotation) => annotation.mask_url);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative aspect-square overflow-hidden rounded border border-gray-800 bg-gray-900"
    >
      <img src={imageUrl} alt={`Frame ${frameId}`} className="h-full w-full object-contain" />
      {maskAnnotations.map((annotation) => {
        const resolved = resolveLabelFromTree(taxonomyTree, annotation.label_id);
        const color = resolved?.tag.color ?? DEFAULT_MASK_COLOR;
        return (
          <div
            key={annotation.id}
            data-testid="mask-overlay"
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundColor: color,
              maskImage: `url(${annotation.mask_url})`,
              WebkitMaskImage: `url(${annotation.mask_url})`,
              maskMode: "luminance",
              WebkitMaskMode: "luminance" as never,
              maskSize: "contain",
              WebkitMaskSize: "contain",
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
              maskPosition: "center",
              WebkitMaskPosition: "center",
              opacity: 0.45,
            }}
          />
        );
      })}
      {annotations.length > 0 && (
        <div className="absolute inset-x-0 bottom-0 flex flex-wrap gap-1 truncate bg-gray-950/80 px-1 py-0.5 text-xs text-gray-200">
          {annotations.map((annotation) => {
            const resolved = resolveLabelFromTree(taxonomyTree, annotation.label_id);
            const label = resolved ? `${resolved.categoryName} / ${resolved.tag.name}` : `label ${annotation.label_id}`;
            const color = resolved?.tag.color ?? "#666";
            return (
              <span key={annotation.id} className="flex items-center gap-1">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                {label}
              </span>
            );
          })}
        </div>
      )}
    </button>
  );
}
```

Note: `WebkitMaskMode` is not in React's standard `CSSProperties` typing, hence the `as never` cast on that one line — every other `Webkit*` mask property used here (`WebkitMaskImage`, `WebkitMaskSize`, `WebkitMaskRepeat`, `WebkitMaskPosition`) is already a recognized standard property in React's CSS typings and needs no cast.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/annotation/FrameThumbnail.test.tsx`
Expected: PASS (6 tests total)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/features/annotation/FrameThumbnail.tsx frontend/src/features/annotation/FrameThumbnail.test.tsx
git commit -m "feat: overlay mask annotations on sequence grid thumbnails via CSS mask-image"
```

---

## Task 4: `SequenceGridPage` fetches sequence + taxonomy tree and passes it down

**Files:**
- Modify: `frontend/src/features/annotation/SequenceGridPage.tsx`
- Create: `frontend/src/features/annotation/SequenceGridPage.test.tsx`

**Interfaces:**
- Consumes: `useSequence(sequenceId: number)` from `../../entities/useSequence` (existing, returns `{data: components["schemas"]["SequenceRead"] | undefined, ...}` where `SequenceRead.procedure_id: number | null`).
- Consumes: `useTaxonomyTree(procedureId: number | null)` from `../../entities/useTaxonomyTree` (existing, returns `{data: components["schemas"]["TaxonomyTreeNode"][] | undefined, ...}`).
- Consumes (from Task 2/3): `FrameThumbnail` now requires a `taxonomyTree` prop.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/features/annotation/SequenceGridPage.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";

import { apiClient } from "../../shared/api/client";
import { SequenceGridPage } from "./SequenceGridPage";

vi.mock("../../shared/api/client", () => ({
  apiClient: { GET: vi.fn() },
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderAtSequence(sequenceId: string) {
  return render(
    <MemoryRouter initialEntries={[`/sequences/${sequenceId}`]}>
      <Routes>
        <Route path="/sequences/:sequenceId" element={<SequenceGridPage />} />
      </Routes>
    </MemoryRouter>,
    { wrapper },
  );
}

describe("SequenceGridPage", () => {
  afterEach(() => vi.clearAllMocks());

  it("fetches the taxonomy tree using the sequence's procedure_id and resolves thumbnail labels", async () => {
    vi.mocked(apiClient.GET).mockImplementation(async (path: string) => {
      if (path === "/media/sequences/{sequence_id}") {
        return {
          data: {
            id: 9,
            name: "Seq",
            video_id: null,
            procedure_id: 7,
            start_time: 0,
            duration: 0,
            annotation_count: 1,
            crop_box: null,
          },
          error: undefined,
        } as never;
      }
      if (path === "/media/videos/{video_id}/sequences" || path.includes("/frames")) {
        return { data: [{ id: 1, sequence_id: 9, storage_key: "k", frame_index: 0, width: 10, height: 10, image_url: "http://x/f.png" }], error: undefined } as never;
      }
      if (path === "/taxonomy/tree") {
        return {
          data: [
            {
              category: { id: 1, name: "Polyp", procedure_id: 7 },
              evaluation_types: [
                {
                  evaluation_type: { id: 10, name: "Morphology" },
                  labels: [{ id: 100, name: "Sessile", color: "#ff0000", category_id: 1 }],
                },
              ],
            },
          ],
          error: undefined,
        } as never;
      }
      if (path === "/annotation/frames/{frame_id}/annotations") {
        return {
          data: [
            {
              id: 1,
              frame_id: 1,
              label_id: 100,
              taxonomy_version: 1,
              annotation_type: "mask",
              status: "pending",
              created_by_id: 1,
              reviewed_by_id: null,
              mask_url: null,
              job_id: null,
            },
          ],
          error: undefined,
        } as never;
      }
      return { data: [], error: undefined } as never;
    });

    renderAtSequence("9");

    expect(await screen.findByText("Polyp / Sessile")).toBeInTheDocument();
    expect(apiClient.GET).toHaveBeenCalledWith(
      "/taxonomy/tree",
      expect.objectContaining({ params: { query: { procedure_id: 7 } } }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/features/annotation/SequenceGridPage.test.tsx`
Expected: FAIL — `SequenceGridPage` doesn't call `useSequence`/`useTaxonomyTree` yet, and/or `FrameThumbnail` errors on a missing required `taxonomyTree` prop (undefined passed where an array is expected causes `resolveLabelFromTree` to throw when iterating).

- [ ] **Step 3: Write minimal implementation**

Replace `frontend/src/features/annotation/SequenceGridPage.tsx` with:

```tsx
import { useState } from "react";
import { useParams } from "react-router-dom";

import { useFrames } from "../../entities/useFrames";
import { useSequence } from "../../entities/useSequence";
import { useTaxonomyTree } from "../../entities/useTaxonomyTree";
import { FrameEditor } from "./FrameEditor";
import { FrameThumbnail } from "./FrameThumbnail";

export function SequenceGridPage() {
  const { sequenceId } = useParams<{ sequenceId: string }>();
  const sequenceIdNumber = Number(sequenceId);
  const [selectedFrameId, setSelectedFrameId] = useState<number | null>(null);

  const framesQuery = useFrames(sequenceIdNumber);
  const sequenceQuery = useSequence(sequenceIdNumber);
  const taxonomyTreeQuery = useTaxonomyTree(sequenceQuery.data?.procedure_id ?? null);
  const taxonomyTree = taxonomyTreeQuery.data ?? [];

  if (selectedFrameId !== null) {
    return (
      <FrameEditor
        frameId={selectedFrameId}
        frames={framesQuery.data ?? []}
        onClose={() => setSelectedFrameId(null)}
        onFrameChange={setSelectedFrameId}
      />
    );
  }

  return (
    <div className="min-h-full bg-gray-950 p-8 text-gray-100">
      <h1 className="mb-4 text-xl font-semibold">Sequence #{sequenceId}</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {(framesQuery.data ?? []).map((frame) => (
          <FrameThumbnail
            key={frame.id}
            frameId={frame.id}
            imageUrl={frame.image_url}
            taxonomyTree={taxonomyTree}
            onClick={() => setSelectedFrameId(frame.id)}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/features/annotation/SequenceGridPage.test.tsx`
Expected: PASS

- [ ] **Step 5: Run the full frontend test suite to confirm no regression**

Run: `cd frontend && npm run test -- --run`
Expected: PASS across all suites (the `prebuild`/`pretest` hook regenerates the API schema first — if that hook fails, run `cd backend && PYTHONPATH=. uv run python scripts/export_openapi.py` from repo root first per CLAUDE.md, then retry).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/features/annotation/SequenceGridPage.tsx frontend/src/features/annotation/SequenceGridPage.test.tsx
git commit -m "feat: wire sequence taxonomy tree into the frame grid thumbnails"
```

---

## Task 5: Manual browser verification

**Files:** none (verification only, no code changes).

This project's CLAUDE.md notes that backend `TestClient` tests and frontend unit tests (which mock `apiClient` entirely) have both previously missed real bugs — a mock-based test proves the component *logic* is right, not that the feature *works* end-to-end against the real running stack. Do this manually before considering the feature done:

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
cd backend && uv run uvicorn app.main:app --reload &
cd frontend && npm run dev &
```

- [ ] **Step 2: Log in and navigate to a sequence with mask annotations**

Use the `manualcheck@example.com` login (see project memory `reference_manual_check_login_and_taxonomy_reimport`). Navigate to a sequence grid page (`/sequences/:id`) that has frames with at least one mask annotation on record.

- [ ] **Step 3: Verify in the browser**

- Thumbnail captions show `<Category> / <Label>` text (not `label <id>`), each with a colored dot matching the label's taxonomy color.
- Frames with mask annotations show a colored, semi-transparent overlay roughly outlining the annotated region, tinted by the label's color.
- Frames with multiple differently-labeled masks show multiple distinct colored overlays stacked.
- Clicking a thumbnail still opens the full `FrameEditor` correctly (unrelated to this change, but confirms `onClick` wiring wasn't broken).
- Open browser devtools console: no errors logged (e.g. no failed `mask_url` image loads, no React key warnings).

- [ ] **Step 4: Report result**

If anything above doesn't match, treat it as a bug in this feature (not a pre-existing issue) and fix before considering the plan done — do not just note it and move on.

---

## Self-Review Notes

- **Spec coverage:** shared helper (Task 1), text caption (Task 2), mask overlay (Task 3), procedure_id/taxonomy wiring (Task 4), real-browser check per CLAUDE.md's testing philosophy (Task 5) — all spec sections have a corresponding task.
- **Placeholders:** none — every step has runnable code and exact commands.
- **Type consistency:** `ResolvedLabel` (Task 1) is reused verbatim in Tasks 2–3; `FrameThumbnail`'s `taxonomyTree: TaxonomyTreeNode[]` prop (Task 2) matches what Task 4 passes (`taxonomyTreeQuery.data ?? []`, an array, never `undefined`).
