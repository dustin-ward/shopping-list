"""Contract smoke check against a running receipt-OCR sidecar.

Answers one question: is this endpoint the engine the app expects? It calls
`GET /healthz`, posts one image to `POST /ocr` and validates the plan §9 payload
(`pages[].lines[]` with boxes and confidences, `pages[].blocks[]`, engine
identity).

    python smoke.py                                   # 127.0.0.1:8060 + the committed fixture
    python smoke.py --url http://receipt-ocr:8060      # compose network
    python smoke.py --image ~/receipt.jpg              # a real capture
    python smoke.py --generate                         # draw one (needs OpenCV, no fixture file)
    python smoke.py --token shared-secret              # proves the token is enforced too

Standard library only, so it also runs inside the published image.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import sample

FIXTURE = Path(__file__).parent / "tests" / "fixtures" / "sample-receipt.png"


class SmokeFailure(Exception):
    pass


def request(
    url: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    content_type: str | None = None,
    token: str | None = None,
    timeout: float = 60.0,
) -> tuple[int, bytes]:
    headers = {}
    if content_type:
        headers["content-type"] = content_type
    if token:
        headers["authorization"] = f"Bearer {token}"
    call = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(call, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except urllib.error.URLError as error:
        raise SmokeFailure(f"cannot reach {url}: {error.reason}") from error


def check_health(base: str, timeout: float) -> dict:
    status, payload = request(f"{base}/healthz", timeout=timeout)
    if status != 200:
        raise SmokeFailure(f"GET /healthz returned HTTP {status}: {payload[:200]!r}")
    health = decode_json(payload, "GET /healthz")
    if health.get("ready") is not True:
        raise SmokeFailure(f"GET /healthz is not ready: {health!r}")
    engine = health.get("engine") or {}
    if not engine.get("name"):
        raise SmokeFailure(f"GET /healthz reports no engine identity: {health!r}")
    return health


def check_ocr(
    base: str, image: bytes, content_type: str, token: str | None, timeout: float
) -> dict:
    status, payload = request(
        f"{base}/ocr",
        method="POST",
        body=image,
        content_type=content_type,
        token=token,
        timeout=timeout,
    )
    if status != 200:
        raise SmokeFailure(f"POST /ocr returned HTTP {status}: {payload[:300]!r}")
    return validate_page(decode_json(payload, "POST /ocr"))


def check_token_is_enforced(base: str, image: bytes, content_type: str, timeout: float) -> None:
    status, _payload = request(
        f"{base}/ocr", method="POST", body=image, content_type=content_type, timeout=timeout
    )
    if status != 401:
        raise SmokeFailure(
            f"the sidecar accepted an unauthenticated POST /ocr (HTTP {status}) "
            "while a token was supplied to this check"
        )


def validate_page(payload: dict) -> dict:
    pages = payload.get("pages")
    if not isinstance(pages, list) or not pages:
        raise SmokeFailure(f"the response has no pages: {payload!r}")
    page = pages[0]
    lines = page.get("lines")
    if not isinstance(lines, list) or not lines:
        raise SmokeFailure("the page has no lines")
    for line in lines:
        box = line.get("box")
        if not isinstance(box, list) or len(box) != 4:
            raise SmokeFailure(f"a line has no four-value box: {line!r}")
        if not isinstance(line.get("text"), str):
            raise SmokeFailure(f"a line has no text: {line!r}")
        confidence = line.get("conf")
        if not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise SmokeFailure(f"a line has an invalid confidence: {line!r}")
    if not isinstance(page.get("blocks"), list):
        raise SmokeFailure("the page has no blocks list")
    for key in ("rotation", "skew", "source"):
        if key not in page:
            raise SmokeFailure(f"the page is missing {key!r}")
    if not (payload.get("engine") or {}).get("name"):
        raise SmokeFailure("the response has no engine identity")
    return payload


def decode_json(payload: bytes, what: str) -> dict:
    try:
        value = json.loads(payload)
    except ValueError as error:
        raise SmokeFailure(f"{what} did not return JSON: {payload[:200]!r}") from error
    if not isinstance(value, dict):
        raise SmokeFailure(f"{what} did not return a JSON object")
    return value


def generate_image() -> bytes:
    """Draw a synthetic receipt page: no fixture file needed inside the image."""
    try:
        return sample.receipt_png()
    except ImportError as error:  # pragma: no cover  (the image always has them)
        raise SmokeFailure("--generate needs OpenCV; pass --image instead") from error


def content_type_for(path: Path | None) -> str:
    if path is None:
        return "image/png"
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }.get(path.suffix.lower(), "application/octet-stream")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8060")
    parser.add_argument(
        "--image",
        type=Path,
        help=f"image to read (default: {FIXTURE.relative_to(Path(__file__).parent)})",
    )
    parser.add_argument(
        "--generate", action="store_true", help="draw a synthetic page instead of --image"
    )
    parser.add_argument("--token", help="bearer token; also proves it is enforced")
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args(argv)

    base = args.url.rstrip("/")

    try:
        if args.generate:
            image, content_type = generate_image(), "image/png"
        else:
            path = args.image or FIXTURE
            if not path.is_file():
                raise SmokeFailure(
                    f"no image at {path}; pass --image PATH or --generate"
                )
            image, content_type = path.read_bytes(), content_type_for(path)

        health = check_health(base, args.timeout)
        if args.token:
            check_token_is_enforced(base, image, content_type, args.timeout)
        payload = check_ocr(base, image, content_type, args.token, args.timeout)
    except SmokeFailure as failure:
        print(f"smoke check failed: {failure}", file=sys.stderr)
        return 1

    page = payload["pages"][0]
    engine = payload["engine"]
    print(
        f"ok: {base} is ready ({engine['name']} {engine.get('package_version')}, "
        f"model {engine.get('model_tag')})"
    )
    print(
        f"ok: one image -> {len(payload['pages'])} page, {len(page['lines'])} lines, "
        f"{len(page['blocks'])} blocks, source={page['source']}, "
        f"rotation={page['rotation']}, skew={page['skew']}"
    )
    if args.token:
        print("ok: an unauthenticated POST /ocr is rejected with 401")
    for line in page["lines"][:5]:
        print(f"    {line['conf']:.2f}  {line['text']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
