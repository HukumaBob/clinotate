# Clinotate (Endoscopy Annotation Platform)

An open-source platform for annotating (classification, segmentation, bounding
boxes) sequential and standalone frames from endoscopic video, and training
computer-vision models on the resulting datasets.

Stack: FastAPI, PostgreSQL, MinIO, Celery/Redis, React/Vite. ML-assisted
labeling and training run in a separate GPU worker (SAM 2 / SAM 3, YOLO).

## Quick start

Requirements: Docker, [uv](https://docs.astral.sh/uv/), Node.js 20+. An NVIDIA
GPU is needed only for the `ml-worker` (SAM / training); the rest runs on CPU.

```bash
cp .env.example .env                  # dev defaults; change JWT_SECRET and passwords for any real deployment
docker compose up -d                  # postgres, redis, minio, ml-worker
cd backend && uv run uvicorn app.main:app --reload            # :8000
cd backend && uv run celery -A app.worker.celery_app worker --loglevel=info -Q video_transcode
cd frontend && npm install --legacy-peer-deps && npm run dev  # :5173
```

The `-Q video_transcode` flag is required; see [CLAUDE.md](CLAUDE.md) for why.
SAM 3 weights are gated on Hugging Face: accept the license there and set
`HF_TOKEN` in `.env`.

## Documentation

- [ROADMAP.md](ROADMAP.md) — phase status and decision log
- [docs/specs/](docs/specs/) — architecture and UI/UX design
  (some specs are written in Russian)
- [CLAUDE.md](CLAUDE.md) — project conventions (also useful for human contributors)
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to run tests and send changes

## Medical disclaimer

This is research and dataset-preparation software. It is not a medical device
and must not be used for diagnosis or treatment decisions. Do not upload
patient-identifiable data to a deployment you do not control.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

**Third-party models and libraries carry their own licenses**, some stricter
than Apache 2.0. In particular Ultralytics YOLO is AGPL-3.0, and SAM 3 and
DINOv3 use custom Meta licenses. If you deploy this as a network service or
commercially, review [NOTICE](NOTICE) first.

## Author

AIIRISDX Inc. (Founders: Nikita Bogatkov, Kurt Abrahams)
Contact: ldc.endoscopy@gmail.com
