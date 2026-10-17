"""Adapter tests against the real Indra pipeline.

The engine tests need `indra_ocr` installed *and* a baked model folder at
`INDRA_OCR_MODEL_DIR` (the image's `/models`, or a local copy); they skip
otherwise. Nothing here downloads models: a container without them is a broken
deployment, not a slow start, and the tests must stay offline.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

pytest.importorskip("cv2")

import sample  # noqa: E402  (import after importorskip)
from indra_engine import (  # noqa: E402
    REQUIRED_MODEL_FILES,
    EngineLoadError,
    UnreadableImage,
    decode_image,
    load_indra_engine,
)
from settings import Settings  # noqa: E402

MODEL_DIR = os.environ.get("INDRA_OCR_MODEL_DIR", "/models")


def settings_for(model_dir: str = MODEL_DIR) -> Settings:
    return Settings(
        port=8060,
        model_dir=model_dir,
        model_tag="test-tag",
        threads=2,
        token=None,
        max_image_bytes=1024,
    )


@pytest.fixture(scope="module")
def engine():
    pytest.importorskip("indra_ocr")
    folder = Path(MODEL_DIR)
    if not folder.is_dir() or not all(
        (folder / name).is_file() for name in REQUIRED_MODEL_FILES
    ):
        pytest.skip(f"no baked Indra models at {MODEL_DIR}")
    return load_indra_engine(settings_for())


def test_describe_reports_the_engine_identity(engine) -> None:
    info = engine.describe()

    assert info["name"] == "indra-ocr"
    assert info["model_tag"] == "test-tag"
    assert info["package_version"].count(".") >= 1


def test_run_returns_the_contract_shape(engine) -> None:
    page = engine.run(sample.receipt_png())

    assert set(page) == {"lines", "blocks", "rotation", "skew", "source"}
    assert page["lines"], "the warm engine read no lines from a printed page"
    for line in page["lines"]:
        assert len(line["box"]) == 4
        assert all(isinstance(value, float) for value in line["box"])
        assert isinstance(line["text"], str)
        assert 0.0 <= line["conf"] <= 1.0
    for block in page["blocks"]:
        assert isinstance(block["label"], str)
        assert len(block["bbox"]) == 4
        assert isinstance(block["text"], str)
    assert page["rotation"] in (0, 90, 180, 270)
    assert isinstance(page["skew"], float)
    assert page["source"] == "ocr"


def test_run_reads_the_printed_text(engine) -> None:
    page = engine.run(sample.receipt_png())

    text = " ".join(line["text"] for line in page["lines"]).upper()
    assert "MILK" in text
    assert "2.99" in text


def test_decode_image_rejects_non_image_bytes() -> None:
    with pytest.raises(UnreadableImage, match="not a readable image"):
        decode_image(b"this is not an image")


def test_a_missing_model_folder_fails_loudly() -> None:
    with pytest.raises(EngineLoadError, match="missing"):
        load_indra_engine(settings_for("/nonexistent-models"))
