from fastapi import FastAPI

from app.auth.router import router as auth_router
from app.media.router import router as media_router
from app.taxonomy.router import router as taxonomy_router

app = FastAPI(title="Endoscopy Annotation Platform API")
app.include_router(auth_router)
app.include_router(taxonomy_router)
app.include_router(media_router)


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}
