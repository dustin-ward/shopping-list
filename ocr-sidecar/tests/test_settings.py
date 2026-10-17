"""Unit tests for the sidecar's environment contract."""

from __future__ import annotations

import pytest

from settings import (
    DEFAULT_MAX_IMAGE_BYTES,
    DEFAULT_MODEL_DIR,
    DEFAULT_PORT,
    DEFAULT_THREADS,
    ConfigError,
    Settings,
    read_settings,
)


def test_defaults_match_the_documented_contract() -> None:
    settings = read_settings({})

    assert settings.port == DEFAULT_PORT == 8060
    assert settings.model_dir == DEFAULT_MODEL_DIR == "/models"
    assert settings.model_tag == "unknown"
    assert settings.threads == DEFAULT_THREADS
    assert settings.token is None
    assert settings.max_image_bytes == DEFAULT_MAX_IMAGE_BYTES


def test_reads_every_override() -> None:
    settings = read_settings(
        {
            "OCR_PORT": "9000",
            "INDRA_OCR_MODEL_DIR": "/opt/models",
            "INDRA_OCR_MODEL_TAG": "v3.1.1",
            "INDRA_OCR_THREADS": "2",
            "RECEIPT_OCR_TOKEN": "shared-secret",
            "OCR_MAX_IMAGE_BYTES": "2048",
        }
    )

    assert settings == Settings(
        port=9000,
        model_dir="/opt/models",
        model_tag="v3.1.1",
        threads=2,
        token="shared-secret",
        max_image_bytes=2048,
    )


def test_blank_values_fall_back_to_the_default() -> None:
    # A blank compose substitution or `.env` line means "unset", matching the
    # app's receipt settings.
    settings = read_settings(
        {
            "OCR_PORT": "  ",
            "INDRA_OCR_MODEL_DIR": "",
            "RECEIPT_OCR_TOKEN": "   ",
        }
    )

    assert settings.port == DEFAULT_PORT
    assert settings.model_dir == DEFAULT_MODEL_DIR
    assert settings.token is None


@pytest.mark.parametrize(
    ("key", "value"),
    [
        ("OCR_PORT", "eighty"),
        ("OCR_PORT", "0"),
        ("INDRA_OCR_THREADS", "-1"),
        ("OCR_MAX_IMAGE_BYTES", "1.5"),
    ],
)
def test_invalid_numbers_fail_loudly(key: str, value: str) -> None:
    with pytest.raises(ConfigError, match=key):
        read_settings({key: value})
