from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.annotation.router import router as annotation_router
from app.auth.router import router as auth_router
from app.datasets.router import router as datasets_router
from app.jobs.router import router as jobs_router
from app.media.router import router as media_router
from app.settings.router import router as settings_router
from app.taxonomy.router import router as taxonomy_router
from app.training.router import router as training_router

import app.inference.models  # noqa: F401 -- registers inference_runs on Base.metadata

app = FastAPI(title="Endoscopy Annotation Platform API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(auth_router)
app.include_router(taxonomy_router)
app.include_router(media_router)
app.include_router(annotation_router)
app.include_router(datasets_router)
app.include_router(jobs_router)
app.include_router(settings_router)
app.include_router(training_router)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}
