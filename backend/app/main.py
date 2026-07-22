from fastapi import FastAPI

app = FastAPI(title="Endoscopy Annotation Platform API")


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok"}
