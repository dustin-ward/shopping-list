# receipt-OCR sidecar

The optional perception box for receipt capture: a stateless HTTP wrapper around
[Datalab Indra OCR](https://github.com/datalab-to/indra), published as
`ghcr.io/<owner>/shopping-list-receipt-ocr`. It owns no database, no files and no
queue — the app owns all of that — so a downed sidecar degrades receipt capture
to pending plus bounded retries instead of an outage. See
`docs/receipt-scanner-plan.html` §9 and
`docs/adr/0002-ocr-as-optional-sidecar.md`.

## Contract

```text
POST /ocr       body: raw image bytes (JPEG/PNG/WebP)
                header: Authorization: Bearer $RECEIPT_OCR_TOKEN   (when configured)
  200 { pages: [{ lines: [{ box: [x0,y0,x1,y1], text, conf }],
                  blocks: [{ label, bbox, text }], rotation, skew, source }],
        engine: { name: 'indra-ocr', model_tag, package_version } }
  400 empty body · 401 bad token · 413 over OCR_MAX_IMAGE_BYTES · 415 unreadable image

GET /healthz   200 { ready: true, engine: {...} }   once the engine is loaded and warm
               503 { ready: false, engine: null }   before that
```

`/healthz` is the compose healthcheck; it never requires the token. `source`
follows Indra's own vocabulary (`ocr`, `text`, `hybrid`, `error`), and
`rotation`/`skew` describe how the page was straightened.

## Image invariants

- **Models are baked, never downloaded:** `INDRA_OCR_MODEL_DIR=/models` and
  `HF_HUB_OFFLINE=1`; the Dockerfile fetches the pinned model revision with `hf
download` at build time (~18 MB, math models excluded). A container with a
  missing model folder exits at start-up instead of reaching the network.
- **CPU-only**, ONNX Runtime with no PyTorch; `INDRA_OCR_THREADS` (default 4)
  caps inference threads.
- **Warm at start-up:** the engine loads and reads one synthetic page before
  uvicorn accepts connections, so a healthy container is one that can read a
  receipt.
- The compose services add the operational caps: ~1 GB memory, read-only root
  filesystem, tmpfs `/tmp`, no published ports, no Linux capabilities.

## Running it

Compose (all profiles, caps and healthcheck included):

```sh
docker compose --profile ocr up -d receipt-ocr      # dev, builds ./ocr-sidecar
docker compose -f compose.prod.yaml --profile ocr up -d receipt-ocr   # published image
```

Directly from a checkout, for development:

```sh
cd ocr-sidecar
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
INDRA_OCR_MODEL_DIR=/path/to/models python app.py    # first run: `hf download datalab-to/indra-ocr --revision v3.1.1 --local-dir /path/to/models`
```

`INDRA_OCR_MODEL_DIR` is required for a local run: this service never downloads
models, and a missing folder is a start-up error.

## Verifying it

```sh
python smoke.py --url http://127.0.0.1:8060                  # healthz + fixture image
python smoke.py --url http://127.0.0.1:8060 --token secret    # also proves the token is enforced
python smoke.py --url http://127.0.0.1:8060 --generate        # draw a page, no fixture file
docker exec <container> python smoke.py                      # inside a running container
```

The same check with no network proves the baked models:

```sh
docker run --rm -d --name ocr-offline --network none --read-only \
  --tmpfs /tmp --memory 1g ghcr.io/<owner>/shopping-list-receipt-ocr:<tag>
docker exec ocr-offline python smoke.py
```

Tests (the contract suite needs no models; the Indra adapter tests run when
`INDRA_OCR_MODEL_DIR` points at a baked model folder):

```sh
pip install -r requirements-dev.txt
INDRA_OCR_MODEL_DIR=/path/to/models python -m pytest
```

The release workflow runs the same suite with `python -m pytest ocr-sidecar`.

## Settings

| Setting               | Default    | Purpose                                                                      |
| --------------------- | ---------- | ---------------------------------------------------------------------------- |
| `OCR_PORT`            | `8060`     | Listen port (never published by compose)                                     |
| `RECEIPT_OCR_TOKEN`   | unset      | When set, `/ocr` requires `Authorization: Bearer <token>`; blank means unset |
| `INDRA_OCR_MODEL_DIR` | `/models`  | Baked model folder                                                           |
| `INDRA_OCR_MODEL_TAG` | `unknown`  | Model revision reported by `/healthz` and `/ocr`                             |
| `INDRA_OCR_THREADS`   | `4`        | ONNX Runtime inference threads                                               |
| `OCR_MAX_IMAGE_BYTES` | `12582912` | Body cap backstop (the app caps uploads at 10 MB)                            |
