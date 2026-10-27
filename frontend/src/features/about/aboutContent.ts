import type { Section } from "./search";

export const SECTIONS: Section[] = [
  {
    id: "overview",
    title: "Overview",
    lead: "Annotate endoscopic video, build datasets and train models — in one place, on your own hardware.",
    blocks: [
      {
        type: "p",
        text: "The platform takes endoscopic recordings from raw video to a trained and inspected computer-vision model. Annotators mark frames with classification labels, segmentation masks and bounding boxes; the platform assembles those annotations into versioned datasets, trains detection and segmentation models on them, and lets you review how the models behave on real video.",
      },
      {
        type: "list",
        items: [
          "On-premises by design: videos, frames, masks and model weights live in your own object storage and never leave the server.",
          "Taxonomy-safe: every annotation records the taxonomy version its label had at creation time, so editing the taxonomy never silently changes what existing annotations mean.",
          "Assisted annotation: SAM 2.1 and SAM 3 turn a few clicks into a mask and can track it across neighbouring frames.",
          "One audit trail: classification, masks and boxes share a single annotation model, status workflow and review process.",
        ],
      },
      {
        type: "table",
        head: ["Role", "What they do"],
        rows: [
          ["Annotator", "Labels frames in Sequences, using the frame editor and SAM assistance."],
          ["Reviewer", "Checks annotations and inspects trained models in QC."],
          ["Admin", "Manages users and the tuning settings available from the gear icon."],
        ],
      },
    ],
  },
  {
    id: "workflow",
    title: "Workflow",
    lead: "Six screens, left to right in the top bar, follow the life of the data.",
    blocks: [
      {
        type: "diagram",
        id: "workflow",
        caption:
          "Workflow: Tags define the taxonomy, Media holds videos, Sequences is where frames are annotated, Dataset assembles annotations, Train fits models, QC inspects them on video.",
      },
      {
        type: "p",
        text: "The loop closes in QC: frames where a model is wrong can be flagged and sent back to training, so each round of review feeds the next training run.",
      },
    ],
  },
  {
    id: "tags",
    title: "Tags",
    lead: "The taxonomy every other screen draws on.",
    blocks: [
      {
        type: "p",
        text: "Tags are the labels used to annotate frames. They form a two-level tree: parent tags such as lesion or landmark only group, while child tags carry a classification and a colour used for mask overlays. Set the taxonomy up first — every dropdown elsewhere is populated from it.",
      },
      {
        type: "list",
        items: [
          "Classification: geometric, morphological or quality — shown as a badge on child tags.",
          "Filter by classification and procedure, or search by name.",
          "Each row shows a mask count: how many annotations currently use the tag.",
          "Colour picker with presets; the same colour is used for masks in the frame editor.",
        ],
      },
    ],
  },
  {
    id: "media",
    title: "Media",
    lead: "Procedures and the videos recorded during them.",
    blocks: [
      {
        type: "p",
        text: "Upload videos and group them by procedure. Uploaded files are transcoded in the background by a dedicated worker so they play smoothly in the browser, and frame metadata (size, frame rate, checksum, perceptual hash) is stored with them.",
      },
      {
        type: "list",
        items: [
          "Video to Sequence: pick a start time, duration, FPS and optional crop, and frames are extracted into a new Sequence.",
          "Photos to Sequence: upload a batch of standalone images as a Sequence.",
          "Review player and a raw media library with file type, size and linked sequences.",
          "Binary data is kept in object storage; the database holds only metadata.",
        ],
      },
    ],
  },
  {
    id: "sequences",
    title: "Sequences",
    lead: "Annotation happens here — there is no separate Annotation section.",
    blocks: [
      {
        type: "p",
        text: "A sequence is a run of frames cut from a video. Opening one shows a full-viewport frame grid; picking a frame opens the frame editor in place of the grid.",
      },
      {
        type: "list",
        items: [
          "Frame grid: see the whole sequence at a glance, with annotation state per frame.",
          "Select mode: bulk frame cleanup — discard blurry or irrelevant frames in one pass.",
          "Classification: assign frame-level labels straight from the grid, and flag frames with no findings.",
          "Rank Quality and Find Similar: sort frames by image quality or find look-alike frames using embeddings.",
          "Frame editor: place positive and negative points for SAM 2.1 or SAM 3 to produce a mask, then refine it.",
          "Track: propagate a mask across neighbouring frames instead of redrawing it.",
          "Mask post-processing: smooth edges and drop tiny fragments, with strength configurable in Settings.",
        ],
      },
    ],
  },
  {
    id: "dataset",
    title: "Dataset",
    lead: "Turn annotations into training-ready, versioned datasets.",
    blocks: [
      {
        type: "p",
        text: "Choose which sequences go in, name the dataset, pick its type and split it into train, validation and test. A live class-balance chart updates as you tick sequences, warning when a class is underrepresented.",
      },
      {
        type: "list",
        items: [
          "Balance panel: per-tag bar chart of mask counts, with optional limits and exclusions.",
          "Auto-apply balance recommendations to even out rare and common classes.",
          "Export to YOLO or COCO format for training or use elsewhere.",
          "Datasets are snapshots: later annotation changes do not alter an existing dataset.",
        ],
      },
    ],
  },
  {
    id: "train",
    title: "Train",
    lead: "An experiment workspace for training and comparing models.",
    blocks: [
      {
        type: "p",
        text: "Pick a dataset and a base model, adjust parameters from a preset, and launch a run. Progress and metrics stream in while it trains; finished runs become model versions you can reuse.",
      },
      {
        type: "list",
        items: [
          "Base models: YOLO11 in n, s, m, l and x sizes.",
          "Fine-tuning: start a new run from an existing model version instead of from scratch.",
          "Runs history: every run with its parameters and headline metric such as mAP50.",
          "Run comparison: put several runs side by side to see which change helped.",
        ],
      },
    ],
  },
  {
    id: "qc",
    title: "QC",
    lead: "Check how a trained model behaves on real video.",
    blocks: [
      {
        type: "p",
        text: "Run a model over a video and play it back with predictions drawn on top. Quality control is where a model's mistakes become visible, and where they get sent back as training material.",
      },
      {
        type: "list",
        items: [
          "Inference runs: pick a model and a video; the run keeps a record you can reopen later.",
          "Inspection: confidence slider, flicker detection and a timeline strip of where the model fires.",
          "Flagging: mark wrong or missed predictions and send them to training.",
          "A/B comparison: play two runs side by side and jump between frames where they disagree.",
          "Stress tests: re-run with a perturbation (Gaussian noise, blur, brightness or JPEG compression) and compare against the clean run.",
          "Review reels: clips around doubtful moments — flicker and low-confidence predictions — that loop for quick review.",
        ],
      },
    ],
  },
  {
    id: "architecture",
    title: "Architecture",
    lead: "A modular monolith plus a GPU worker, deployed with docker compose.",
    blocks: [
      {
        type: "diagram",
        id: "architecture",
        caption:
          "Architecture: a React single-page app talks REST to the FastAPI core API, which stores data in PostgreSQL and MinIO and hands long jobs to Celery workers through Redis.",
      },
      {
        type: "p",
        text: "The core API is split into independent domain packages — auth, taxonomy, media, annotation, datasets, training and jobs — each with its own router, models and service. Long-running work (SAM inference, mask tracking, dataset export, training, video transcoding) runs as jobs in Celery workers, which report progress back to the API.",
      },
      {
        type: "table",
        head: ["Layer", "Technology"],
        rows: [
          ["Frontend", "React, Vite, Tailwind (dark theme), TanStack Query, Zustand"],
          ["API", "FastAPI with auto-generated OpenAPI and a typed TypeScript client"],
          ["Database", "PostgreSQL with JSONB payloads, recursive queries for the tag hierarchy, pgvector for similarity search"],
          ["Queue", "Celery over Redis"],
          ["Object storage", "MinIO (S3 API) behind a single storage service"],
          ["ML", "Dedicated GPU worker running SAM 2.1, SAM 3 and YOLO training"],
        ],
      },
    ],
  },
  {
    id: "glossary",
    title: "Glossary",
    lead: "Terms used across the platform.",
    blocks: [
      {
        type: "terms",
        items: [
          { term: "Procedure", def: "An endoscopic examination that videos are grouped under." },
          { term: "Sequence", def: "A run of frames cut from a video, annotated as a unit." },
          { term: "Frame", def: "A single still image from a video, the unit that carries annotations." },
          { term: "Label / Tag", def: "A named class from the taxonomy, with a classification and colour." },
          { term: "Taxonomy version", def: "The version of a label when an annotation was made; copied onto the annotation and never re-derived." },
          { term: "Annotation", def: "A classification, mask or bounding box attached to a frame." },
          { term: "Mask", def: "A pixel-accurate outline of a region, usually produced with SAM." },
          { term: "Job", def: "A background task such as inference, tracking, export, training or transcoding." },
          { term: "Run", def: "One training or inference execution, with its parameters and results." },
          { term: "Model version", def: "A trained model kept for reuse, linked to its dataset and parent model." },
        ],
      },
    ],
  },
  {
    id: "license",
    title: "License",
    blocks: [
      {
        type: "p",
        text: "Built by AIIRISDX Inc. Open source under the Apache License, Version 2.0. See NOTICE in the repository for attribution of third-party models and libraries.",
      },
      { type: "p", text: "Contact: ldc.endoscopy@gmail.com" },
    ],
  },
];
