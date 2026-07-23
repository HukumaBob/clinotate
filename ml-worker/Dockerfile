FROM nvidia/cuda:12.6.0-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=Etc/UTC

RUN apt-get update && apt-get install -y --no-install-recommends \
    software-properties-common \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3.12 python3.12-venv python3-pip git curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

# torch and torchvision must be installed together as a matched pair from the
# cu126 index. Installing torch unpinned and letting sam3 pull in torchvision
# transitively resolves to mismatched releases (observed: torch 2.13.0+cu126 +
# torchvision 0.28.0) whose compiled ops don't register against each other,
# raising `RuntimeError: operator torchvision::nms does not exist` at import
# time. Pin both from the same release line to keep them compatible.
RUN uv pip install "torch==2.7.1" "torchvision==0.22.1" --index-url https://download.pytorch.org/whl/cu126
RUN uv pip install "sam3 @ git+https://github.com/facebookresearch/sam3.git"
# sam3's own package metadata under-declares its runtime dependencies: these
# four are imported eagerly by sam3's __init__ chain (including training-only
# code paths) but are missing from its `Requires-Dist` list, so uv/pip won't
# pull them in automatically.
RUN uv pip install einops pycocotools psutil

COPY app ./app

CMD ["uv", "run", "celery", "-A", "app.celery_app", "worker", "--loglevel=info"]
