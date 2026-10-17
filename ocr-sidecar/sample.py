"""A synthetic printed page, drawn once for every consumer that needs one.

The engine's warm-up, the smoke check's `--generate` and the adapter tests all
want a handful of printed lines; drawing them here keeps the page identical
everywhere. OpenCV arrives with indra-ocr, so the import stays inside the
function: nothing that only needs the HTTP contract pays for it.
"""

from __future__ import annotations

DEFAULT_LINES = (
    "HARBOUR MARKET",
    "MILK 2.99",
    "BREAD 3.49",
    "TOTAL 6.48",
)


def receipt_page(lines: tuple[str, ...] = DEFAULT_LINES):
    """A grayscale page of printed-looking text, one line per entry."""
    import cv2
    import numpy as np

    page = np.full((360, 520), 255, np.uint8)
    for index, text in enumerate(lines):
        cv2.putText(
            page,
            text,
            (20, 80 + index * 70),
            cv2.FONT_HERSHEY_SIMPLEX,
            1.1,
            0,
            2,
            cv2.LINE_AA,
        )
    return page


def receipt_png(lines: tuple[str, ...] = DEFAULT_LINES) -> bytes:
    """`receipt_page` encoded as PNG bytes, the way a request body arrives."""
    import cv2

    encoded, buffer = cv2.imencode(".png", receipt_page(lines))
    if not encoded:  # pragma: no cover  (OpenCV only refuses impossible sizes)
        raise RuntimeError("could not encode the synthetic page")
    return buffer.tobytes()
