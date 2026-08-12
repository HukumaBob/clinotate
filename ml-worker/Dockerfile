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
# Pinned to the exact commit this image (and app/sam3_adapter.py's
# monkeypatch of sam3.perflib.fused.addmm_act, see that module's docstring)
# was verified against. sam3 is installed from git HEAD with no releases, so
# an unpinned install could silently pick up upstream changes -- including a
# fix for the dtype bug this project patches around -- without a visible,
# reviewed commit bump. Bump deliberately, and re-verify the patch (or drop
# it if upstream has merged an equivalent fix; see
# https://github.com/facebookresearch/sam3/pull/570) when updating this pin.
RUN uv pip install "sam3 @ git+https://github.com/facebookresearch/sam3.git@46957e47805eaa273f4aa7bbbd25a88bca9108ce"
# sam3's own package metadata under-declares its runtime dependencies: these
# four are imported eagerly by sam3's __init__ chain (including training-only
# code paths) but are missing from its `Requires-Dist` list, so uv/pip won't
# pull them in automatically.
RUN uv pip install einops pycocotools psutil

# sam2 has no official PyPI package either -- same git-install pattern as
# sam3 above. Pinned to a specific commit for the same reason sam3 is: an
# unpinned git install could silently change behavior between builds with
# no visible, reviewed diff. This is the confirmed `main` HEAD as of
# 2026-07-23 (git ls-remote https://github.com/facebookresearch/sam2.git
# main). Verify against https://github.com/facebookresearch/sam2/commits/main
# before bumping.
#
# --no-deps is required: sam2's package name on git is "sam-2" (a hyphen,
# confirmed via its setup.py's `NAME = "SAM-2"` -- `uv pip install "sam2 @
# git+..."` fails outright with a metadata-name mismatch). More importantly,
# sam2's dependency list (torch>=2.5.1, torchvision>=0.20.1) has no upper
# bound, so without --no-deps uv's resolver ignores the already-installed,
# already-compatible torch==2.7.1/torchvision==0.22.1 pair above and
# resolves a completely new, unrelated torch==2.13.0/CUDA-13 stack instead
# -- confirmed empirically (a `uv pip install --verbose` run showed exactly
# this, re-downloading ~2-3GB of nvidia-cu13 packages before being killed).
# sam2's own real runtime dependencies beyond torch/torchvision/numpy/pillow
# (already satisfied by sam3's install above) are installed explicitly on
# the next line, confirmed against the installed commit's real setup.py
# (`REQUIRED_PACKAGES`), not guessed from a README.
#
# SAM2_BUILD_CUDA=0: sam2's setup.py builds an optional CUDA extension
# (sam2._C, used only for post-processing, not core predict()/track())
# by default. This base image is nvidia/cuda:12.6.0-*runtime*, not -devel
# -- nvcc is not present (confirmed: `which nvcc` -> not found) -- so the
# extension build cannot succeed here. Disabling it via this env var
# (sam2's own documented escape hatch, see its setup.py) avoids attempting
# a build that's guaranteed to fail on this base image; losing this
# optional extension does not affect Sam2Adapter, which only uses
# SAM2ImagePredictor/SAM2VideoPredictor's Python-level API, not sam2._C
# directly. (The `uv pip install --no-deps` step below is separately slow
# on a cold cache -- ~4-5 minutes for dependency resolution against a
# single git package with no upper-bounded version constraints -- not
# hung; a `--verbose` run during investigation confirmed real, if slow,
# progress the whole time.)
ENV SAM2_BUILD_CUDA=0
RUN uv pip install --no-deps "sam-2 @ git+https://github.com/facebookresearch/sam2.git@2b90b9f5ceec907a1c18123530e92e794ad901a4"
RUN uv pip install "hydra-core>=1.3.2" "iopath>=0.1.10" "tqdm>=4.66.1"

# TOPIQ (Rank Quality's primary no-reference quality metric) and the
# OpenCV Laplacian-variance fallback used when pyiqa/torch fail to load --
# see docs/superpowers/specs/2026-08-12-sequence-grid-quality-similarity-suggestions-design.md.
# Both are pure-PyPI packages that work against the already-pinned
# torch==2.7.1 above; opencv-python-headless (not opencv-python) since this
# is a server container with no display.
#
# The second install is required, not redundant: pyiqa's transitive
# dependency facexlib declares a dependency on plain opencv-python (GUI
# build), so the first command's resolver installs *both* opencv-python
# and opencv-python-headless side by side -- confirmed empirically inside
# this image. Both packages provide the same top-level `cv2` module, and
# whichever wins the import breaks: this base image is nvidia/cuda:*-
# runtime (no X11/libxcb, confirmed via `ldconfig -p | grep xcb` finding
# nothing), so if plain opencv-python's native extension is what loads,
# `import cv2` raises `ImportError: libxcb.so.1: cannot open shared
# object file`. --force-reinstall --no-deps replaces whatever `cv2`
# ended up installed with the headless build's, without re-resolving or
# disturbing pyiqa/facexlib's other already-satisfied dependencies.
RUN uv pip install "pyiqa>=0.1.13" "opencv-python-headless>=4.10.0" \
    && uv pip install --force-reinstall --no-deps "opencv-python-headless>=4.10.0"

COPY app ./app

# --pool=solo: the default prefork pool forks worker subprocesses per task,
# and CUDA cannot be re-initialized inside a forked child process ("Cannot
# re-initialize CUDA in forked subprocess" at runtime). There is one GPU to
# share regardless, so a single-threaded solo pool is the correct fix, not a
# workaround: https://docs.celeryq.dev/en/stable/userguide/concurrency/index.html
CMD ["uv", "run", "celery", "-A", "app.celery_app", "worker", "--loglevel=info", "--pool=solo"]
