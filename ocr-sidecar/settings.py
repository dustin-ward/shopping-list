"""Runtime configuration for the receipt-OCR sidecar.

Read once at start-up, with a loud failure on an invalid value: a misconfigured
container should stop, not serve a half-configured contract. Every OCR setting
the app already owns (`RECEIPT_OCR_TOKEN` and the model directory) keeps the
name it has elsewhere in the stack, so one `.env` line configures both sides.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

DEFAULT_PORT = 8060
DEFAULT_MODEL_DIR = "/models"
DEFAULT_THREADS = 4
# The app caps uploads at 10 MB and refuses more; the sidecar's own cap is a
# defence-in-depth backstop for a directly reachable engine (deployment mode B).
DEFAULT_MAX_IMAGE_BYTES = 12 * 1024 * 1024


class ConfigError(ValueError):
    """The environment does not describe a usable sidecar."""


@dataclass(frozen=True)
class Settings:
    """Everything the sidecar needs to serve, resolved from the environment."""

    port: int
    model_dir: str
    model_tag: str
    threads: int
    token: str | None
    max_image_bytes: int


def read_settings(env: Mapping[str, str] | None = None) -> Settings:
    """Build `Settings` from `env` (default: the process environment)."""
    values = os.environ if env is None else env
    return Settings(
        port=_integer(values, "OCR_PORT", DEFAULT_PORT),
        model_dir=_text(values, "INDRA_OCR_MODEL_DIR", DEFAULT_MODEL_DIR),
        model_tag=_text(values, "INDRA_OCR_MODEL_TAG", "unknown"),
        threads=_integer(values, "INDRA_OCR_THREADS", DEFAULT_THREADS),
        token=_optional_text(values, "RECEIPT_OCR_TOKEN"),
        max_image_bytes=_integer(
            values, "OCR_MAX_IMAGE_BYTES", DEFAULT_MAX_IMAGE_BYTES
        ),
    )


def _text(env: Mapping[str, str], key: str, default: str) -> str:
    value = env.get(key)
    return value.strip() if value and value.strip() else default


def _optional_text(env: Mapping[str, str], key: str) -> str | None:
    """A blank value means unset, matching the app's receipt settings."""
    value = env.get(key)
    return value.strip() if value and value.strip() else None


def _integer(env: Mapping[str, str], key: str, default: int) -> int:
    value = _text(env, key, str(default))
    try:
        number = int(value)
    except ValueError:
        raise ConfigError(f"{key} must be a whole number, not {value!r}") from None
    if number <= 0:
        raise ConfigError(f"{key} must be positive, not {value!r}")
    return number
