# The OCR unit from docs/receipt-scanner-plan.html §9: Python 3.13 slim, a
# pinned indra-ocr, and the models baked into the image at build time so the
# container never reaches the network at start-up.
#
# Build:  docker build -t shopping-list-receipt-ocr .
# Run:    docker run --rm -p 8060:8060 shopping-list-receipt-ocr
# (the compose services add the memory cap, read-only rootfs and healthcheck).
#
# Pin the multi-architecture Python image digest; update deliberately alongside
# the pinned indra-ocr and model revision below.
FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641 AS build

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /srv

# The model files this package version was built against (a Hugging Face tag).
ARG INDRA_OCR_MODEL_REPO=datalab-to/indra-ocr
ARG INDRA_OCR_MODEL_REVISION=v3.1.1

RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Bake the ~18 MB core models. The math models are not used for receipts, so
# they stay out. This build stage is the only place the models are fetched;
# the runtime image points INDRA_OCR_MODEL_DIR at the baked folder and sets
# HF_HUB_OFFLINE=1, so nothing at start-up can reach Hugging Face.
RUN hf download "$INDRA_OCR_MODEL_REPO" \
        --revision "$INDRA_OCR_MODEL_REVISION" \
        --local-dir /models \
        --include "*.onnx" \
        --include "meta.json" \
        --exclude "math*" \
    && rm -rf /models/.cache \
    && chmod -R a+rX /models

FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641 AS runtime

ARG INDRA_OCR_MODEL_REVISION=v3.1.1

# HOME points into the tmpfs the compose services mount: the root filesystem is
# read-only, and nothing here should write outside /tmp anyway.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    PATH=/opt/venv/bin:$PATH \
    OCR_PORT=8060 \
    INDRA_OCR_MODEL_DIR=/models \
    INDRA_OCR_MODEL_TAG=$INDRA_OCR_MODEL_REVISION \
    HF_HUB_OFFLINE=1 \
    HF_HOME=/tmp/huggingface

RUN groupadd --system --gid 10001 ocr \
    && useradd --system --uid 10001 --gid ocr --home-dir /tmp --shell /usr/sbin/nologin ocr

WORKDIR /srv

COPY --from=build /opt/venv /opt/venv
COPY --from=build /models /models
COPY app.py indra_engine.py sample.py settings.py smoke.py ./
# The smoke check's default image travels with the service: `docker exec …
# python smoke.py` verifies a running container (also with --network none),
# without a fixture file from the host.
COPY tests/fixtures/sample-receipt.png ./tests/fixtures/sample-receipt.png

USER 10001:10001

# No published ports: the app reaches this over the compose network, and a
# remote engine is exposed deliberately (plan §11, deployment mode B).
EXPOSE 8060

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD python -c "import json, os, urllib.request; health = json.load(urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('OCR_PORT', '8060') + '/healthz', timeout=3)); raise SystemExit(0 if health.get('ready') else 1)"

CMD ["python", "app.py"]
