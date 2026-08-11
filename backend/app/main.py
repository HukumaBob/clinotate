from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.annotation.router import router as annotation_router
from app.auth.router import router as auth_router
from app.jobs.router import router as jobs_router
from app.media.router import router as media_router
from app.settings.router import router as settings_router
from app.taxonomy.router import router as taxonomy_router

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
app.include_router(jobs_router)
app.include_router(settings_router)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}
