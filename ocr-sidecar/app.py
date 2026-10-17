"""HTTP surface of the receipt-OCR sidecar.

Two routes, one process, no state of its own: `POST /ocr` turns raw image bytes
into the lines/blocks JSON the app's parser consumes (plan §9), and `GET
/healthz` is the compose healthcheck. The engine is loaded and warmed before the
server accepts connections, so a container that answers `/healthz` is a container
that can read a receipt.

Run it directly (`python app.py`) or as `uvicorn app:create_app --factory`.
"""

from __future__ import annotations

import hmac
import logging
from contextlib import asynccontextmanager
from typing import Callable

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from indra_engine import (
    OcrEngine,
    UnreadableImage,
    load_indra_engine,
)
from settings import Settings, read_settings

logger = logging.getLogger("receipt-ocr")

EngineLoader = Callable[[Settings], OcrEngine]


def create_app(
    settings: Settings | None = None,
    engine: OcrEngine | None = None,
    engine_loader: EngineLoader = load_indra_engine,
) -> FastAPI:
    """Build the ASGI app. `engine` and `settings` are injectable for tests."""
    config = settings or read_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if app.state.engine is None:
            logger.info(
                "loading Indra OCR from %s (%s threads)",
                config.model_dir,
                config.threads,
            )
            app.state.engine = engine_loader(config)
        logger.info("receipt-ocr ready: %s", app.state.engine.describe())
        yield

    app = FastAPI(
        title="shopping-list-receipt-ocr",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    app.state.engine = engine

    @app.get("/healthz")
    async def healthz(request: Request) -> JSONResponse:
        """Ready only once the engine is loaded and warm (compose healthcheck)."""
        loaded: OcrEngine | None = request.app.state.engine
        if loaded is None:
            return JSONResponse({"ready": False, "engine": None}, status_code=503)
        return JSONResponse({"ready": True, "engine": loaded.describe()})

    @app.post("/ocr")
    async def ocr(request: Request) -> JSONResponse:
        """Read raw image bytes into lines, layout blocks and page geometry."""
        rejected = _authorize(request, config.token)
        if rejected is not None:
            return rejected

        body = await request.body()
        if not body:
            return JSONResponse(
                {"detail": "the request body is empty"}, status_code=400
            )
        if len(body) > config.max_image_bytes:
            return JSONResponse(
                {
                    "detail": (
                        f"the request body is larger than the "
                        f"{config.max_image_bytes} byte limit"
                    )
                },
                status_code=413,
            )

        try:
            page = await run_in_threadpool(request.app.state.engine.run, body)
        except UnreadableImage as error:
            return JSONResponse({"detail": str(error)}, status_code=415)

        return JSONResponse(
            {"pages": [page], "engine": request.app.state.engine.describe()}
        )

    return app


def _authorize(request: Request, token: str | None) -> JSONResponse | None:
    """Enforce the shared bearer token when one is configured (plan §9/§11)."""
    if token is None:
        return None
    scheme, _, presented = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(
        presented.strip(), token
    ):
        return JSONResponse(
            {"detail": "a valid bearer token is required"},
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )
    return None


def main() -> None:
    config = read_settings()
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(
        create_app(config),
        # Bind the compose network only: the service publishes no host port.
        host="0.0.0.0",
        port=config.port,
        server_header=False,
    )


if __name__ == "__main__":
    main()
