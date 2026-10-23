"""Contract tests for the sidecar's HTTP surface.

A fake engine stands in for Indra: these tests pin the HTTP contract (routes,
status codes, bearer token, the plan §9 payload) without ONNX Runtime, models or
a network. `test_indra_engine.py` covers the real engine when it is installed.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import create_app
from indra_engine import UnreadableImage
from settings import Settings

PAGE: dict[str, Any] = {
    "lines": [
        {"box": [12.0, 40.0, 210.0, 66.0], "text": "MILK 2.99", "conf": 0.97},
        {"box": [12.0, 80.0, 210.0, 106.0], "text": "TOTAL 2.99", "conf": 0.93},
    ],
    "blocks": [
        {"label": "Table", "bbox": [8.0, 32.0, 240.0, 120.0], "text": "MILK 2.99"},
    ],
    "rotation": 0,
    "skew": 0.0,
    "source": "ocr",
}

IMAGE = b"\x89PNG\r\n\x1a\nfake-image"


class FakeEngine:
    """An `OcrEngine` that records requests and replays one page."""

    def __init__(
        self,
        page: dict[str, Any] | None = None,
        error: Exception | None = None,
    ) -> None:
        self.page = PAGE if page is None else page
        self.error = error
        self.received: list[bytes] = []

    def describe(self) -> dict[str, Any]:
        return {
            "name": "fake-engine",
            "model_tag": "test-model",
            "package_version": "0.0.0",
        }

    def run(self, image_bytes: bytes) -> dict[str, Any]:
        self.received.append(image_bytes)
        if self.error is not None:
            raise self.error
        return self.page


def build_settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "port": 8060,
        "model_dir": "/models",
        "model_tag": "test-model",
        "threads": 1,
        "token": None,
        "max_image_bytes": 1024,
    }
    values.update(overrides)
    return Settings(**values)


def client_for(
    engine: FakeEngine | None = None,
    **overrides: Any,
):
    app = create_app(settings=build_settings(**overrides), engine=engine)
    return app, TestClient(app)


def test_healthz_reports_ready_and_engine_identity() -> None:
    engine = FakeEngine()
    _app, client = client_for(engine)

    with client:
        response = client.get("/healthz")

    assert response.status_code == 200
    assert response.json() == {"ready": True, "engine": engine.describe()}


def test_healthz_reports_not_ready_before_the_engine_is_loaded() -> None:
    # No lifespan: the app is serving but has no engine yet.
    _app, client = client_for(engine=None)

    response = client.get("/healthz")

    assert response.status_code == 503
    assert response.json() == {"ready": False, "engine": None}


def test_startup_loads_the_engine_once_with_the_configured_settings() -> None:
    calls: list[Settings] = []

    def loader(settings: Settings) -> FakeEngine:
        calls.append(settings)
        return FakeEngine()

    app = create_app(
        settings=build_settings(threads=3, model_tag="v9.9.9"),
        engine_loader=loader,
    )

    with TestClient(app) as client:
        assert client.get("/healthz").json()["ready"] is True

    assert calls == [build_settings(threads=3, model_tag="v9.9.9")]


def test_ocr_returns_the_plan_contract_for_the_submitted_bytes() -> None:
    engine = FakeEngine()
    _app, client = client_for(engine)

    with client:
        response = client.post(
            "/ocr", content=IMAGE, headers={"content-type": "image/png"}
        )

    assert response.status_code == 200
    assert engine.received == [IMAGE]
    body = response.json()
    assert body == {"pages": [PAGE], "engine": engine.describe()}
    assert body["pages"][0]["lines"][0]["box"] == [12.0, 40.0, 210.0, 66.0]
    assert body["pages"][0]["blocks"][0]["label"] == "Table"


def test_ocr_rejects_an_empty_body() -> None:
    _app, client = client_for(FakeEngine())

    with client:
        response = client.post("/ocr", content=b"")

    assert response.status_code == 400
    assert "empty" in response.json()["detail"]


def test_ocr_rejects_a_body_over_the_size_cap() -> None:
    engine = FakeEngine()
    _app, client = client_for(engine, max_image_bytes=4)

    with client:
        response = client.post("/ocr", content=b"12345")

    assert response.status_code == 413
    assert "byte limit" in response.json()["detail"]
    assert engine.received == []


def test_ocr_reports_an_unreadable_image_as_unsupported_media() -> None:
    _app, client = client_for(
        FakeEngine(error=UnreadableImage("the request body is not a readable image"))
    )

    with client:
        response = client.post("/ocr", content=b"not-an-image")

    assert response.status_code == 415
    assert "not a readable image" in response.json()["detail"]


def test_ocr_requires_the_configured_bearer_token() -> None:
    engine = FakeEngine()
    _app, client = client_for(engine, token="shared-secret")

    with client:
        missing = client.post("/ocr", content=IMAGE)
        wrong = client.post(
            "/ocr", content=IMAGE, headers={"authorization": "Bearer nope"}
        )
        wrong_scheme = client.post(
            "/ocr", content=IMAGE, headers={"authorization": "shared-secret"}
        )
        accepted = client.post(
            "/ocr", content=IMAGE, headers={"authorization": "Bearer shared-secret"}
        )
        health = client.get("/healthz")

    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"
    assert wrong.status_code == 401
    assert wrong_scheme.status_code == 401
    assert accepted.status_code == 200
    assert health.status_code == 200
    # Only the authorised request reached the engine.
    assert engine.received == [IMAGE]


@pytest.mark.parametrize("authorization", ["bearer shared-secret", "BEARER shared-secret"])
def test_ocr_accepts_the_bearer_scheme_case_insensitively(
    authorization: str,
) -> None:
    engine = FakeEngine()
    _app, client = client_for(engine, token="shared-secret")

    with client:
        response = client.post(
            "/ocr", content=IMAGE, headers={"authorization": authorization}
        )

    assert response.status_code == 200
