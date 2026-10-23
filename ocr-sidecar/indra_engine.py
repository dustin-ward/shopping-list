"""The Indra OCR adapter — the only module that touches the perception stack.

`app.py` knows nothing about ONNX Runtime, models or Indra: it needs an object
satisfying `OcrEngine`, so the engine stays replaceable behind the same HTTP
contract (plan §9 reserves a heavier engine, e.g. Surya 2, for the same door).
Heavy imports are deferred into the module's functions, which keeps this module
importable in tests and in a container whose models never arrive.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Protocol, TypedDict

import sample
from settings import Settings


class EngineLoadError(RuntimeError):
    """The engine could not be loaded (models missing, ONNX Runtime failure)."""


class UnreadableImage(Exception):
    """The submitted bytes are not a decodable image."""


class OcrLine(TypedDict):
    box: list[float]
    text: str
    conf: float


class OcrBlock(TypedDict):
    label: str
    bbox: list[float]
    text: str


class OcrPage(TypedDict):
    lines: list[OcrLine]
    blocks: list[OcrBlock]
    rotation: int
    skew: float
    source: str


class OcrEngineInfo(TypedDict):
    name: str
    model_tag: str
    package_version: str


class OcrEngine(Protocol):
    """What the HTTP layer requires of an engine."""

    def describe(self) -> OcrEngineInfo:
        """Engine identity for `/healthz` and every `/ocr` response."""

    def run(self, image_bytes: bytes) -> OcrPage:
        """One page of contract JSON: lines, blocks, rotation, skew, source."""


# The files Indra needs for a page: the detector, the recognizer, the reading
# order model and the metadata (vocab, geometry constants). The image also bakes
# orient.onnx, script.onnx and rec_cjk.onnx, which Indra loads when present.
REQUIRED_MODEL_FILES = ("det.onnx", "rec.onnx", "order.onnx", "meta.json")


def load_indra_engine(settings: Settings) -> "IndraEngine":
    """Load Indra from the baked model folder and read one warm-up page.

    The folder is passed explicitly (and the image sets `INDRA_OCR_MODEL_DIR`
    and `HF_HUB_OFFLINE=1` as well), so the container has no code path that
    downloads models at start-up.
    """
    _check_model_folder(settings.model_dir)

    import indra_ocr

    try:
        ocr = indra_ocr.OrtOCR(settings.model_dir, threads=settings.threads)
    except Exception as error:  # noqa: BLE001  (any load failure is fatal)
        raise EngineLoadError(
            f"could not load Indra OCR from {settings.model_dir}: "
            f"{type(error).__name__}: {error}"
        ) from error

    engine = IndraEngine(
        ocr=ocr,
        model_tag=settings.model_tag,
        package_version=indra_ocr.__version__,
    )
    try:
        engine.warm_up()
    except Exception as error:  # noqa: BLE001  (a cold engine must not serve)
        raise EngineLoadError(
            f"Indra OCR at {settings.model_dir} failed to read its warm-up page: "
            f"{type(error).__name__}: {error}"
        ) from error
    return engine


def _check_model_folder(model_dir: str) -> None:
    folder = Path(model_dir)
    if not folder.is_dir():
        raise EngineLoadError(
            f"the model folder {model_dir} is missing: the image bakes its models "
            "at build time, so this is a broken deployment, not a download problem"
        )
    missing = [name for name in REQUIRED_MODEL_FILES if not (folder / name).is_file()]
    if missing:
        raise EngineLoadError(
            f"the model folder {model_dir} lacks {', '.join(missing)}"
        )


class IndraEngine:
    """Indra OCR behind the `OcrEngine` protocol, loaded once per container."""

    def __init__(self, ocr: Any, model_tag: str, package_version: str) -> None:
        self._ocr = ocr
        self._model_tag = model_tag
        self._package_version = package_version
        # The app is single-concurrency by design and one receipt at a time is
        # what a household produces; serialising here keeps ONNX Runtime's
        # per-session state and memory predictable under a stray second caller.
        self._lock = threading.Lock()

    def describe(self) -> OcrEngineInfo:
        return {
            "name": "indra-ocr",
            "model_tag": self._model_tag,
            "package_version": self._package_version,
        }

    def run(self, image_bytes: bytes) -> OcrPage:
        return self._read_page(decode_image(image_bytes))

    def warm_up(self) -> None:
        """Read one synthetic page so the first real receipt is not the cold run."""
        self._read_page(sample.receipt_page())

    def _read_page(self, frame) -> OcrPage:
        with self._lock:
            page = self._ocr(frame)
        return {
            "lines": [
                {
                    "box": [float(value) for value in line.box],
                    "text": line.text,
                    "conf": float(line.conf),
                }
                for line in page.lines
            ],
            "blocks": [
                {
                    "label": block["label"],
                    "bbox": [float(value) for value in block["bbox"]],
                    "text": block["text"],
                }
                for block in page.blocks
            ],
            "rotation": int(page.rotation),
            "skew": round(float(page.skew), 2),
            "source": page.source,
        }


def decode_image(image_bytes: bytes):
    """Grayscale page for the engine, or `UnreadableImage` if the bytes are not one."""
    if not image_bytes:
        raise UnreadableImage("the request body is empty")
    # Imported here (not at module scope) so the contract can be served, and
    # tested, without OpenCV and NumPy in the process.
    import cv2
    import numpy as np

    frame = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_GRAYSCALE)
    if frame is None:
        raise UnreadableImage(
            "the request body is not a readable image (JPEG, PNG or WebP)"
        )
    return np.ascontiguousarray(frame)
