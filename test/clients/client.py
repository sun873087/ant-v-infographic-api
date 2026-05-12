#!/usr/bin/env python3
"""使用 Python (stdlib only) 呼叫 Infographic API。

用法:
    BASE_URL=http://localhost:3000 python3 test/clients/client.py
"""
from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import urllib.request
import urllib.parse
from pathlib import Path

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000")
OUT_DIR = Path(
    os.environ.get("OUT_DIR")
    or os.path.join(tempfile.gettempdir(), "infographic-python")
)
OUT_DIR.mkdir(parents=True, exist_ok=True)

SYNTAX = """\
infographic list-row-horizontal-icon-arrow
data
  items
    - label Plan
      desc Design
      icon mdi/lightbulb-outline
    - label Build
      icon mdi/hammer-screwdriver
    - label Ship
      icon mdi/rocket-launch"""


def get(path: str) -> tuple[int, bytes, dict[str, str]]:
    req = urllib.request.Request(f"{BASE_URL}{path}")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, resp.read(), dict(resp.headers)


def post_render(syntax: str, fmt: str = "svg") -> bytes:
    body = json.dumps({"syntax": syntax}).encode("utf-8")
    qs = urllib.parse.urlencode({"format": fmt})
    req = urllib.request.Request(
        f"{BASE_URL}/render?{qs}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        if resp.status != 200:
            raise RuntimeError(f"unexpected status {resp.status}")
        return resp.read()


def base64url_encode(s: str) -> str:
    b = base64.urlsafe_b64encode(s.encode("utf-8")).decode("ascii")
    return b.rstrip("=")


def main() -> int:
    status, body, _ = get("/healthz")
    assert status == 200 and json.loads(body)["status"] == "ok", "healthz failed"
    print(f"[py] healthz OK")

    svg = post_render(SYNTAX, "svg")
    (OUT_DIR / "out.svg").write_bytes(svg)
    assert svg.startswith(b"<?xml") or svg.startswith(b"<svg"), "not an SVG"
    print(f"[py] POST /render?format=svg  {len(svg)}B")

    png = post_render(SYNTAX, "png")
    (OUT_DIR / "out.png").write_bytes(png)
    assert png[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    print(f"[py] POST /render?format=png  {len(png)}B")

    encoded = base64url_encode(SYNTAX)
    status, svg2, headers = get(f"/render/{encoded}.svg")
    (OUT_DIR / "get.svg").write_bytes(svg2)
    assert status == 200
    print(f"[py] GET /render/:enc.svg     {len(svg2)}B  X-Cache={headers.get('X-Cache')}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
