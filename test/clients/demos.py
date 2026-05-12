#!/usr/bin/env python3
"""Python (stdlib only) demos client。

讀 test/clients/demos/*.txt,把每個 syntax 渲染成 SVG + PNG。

用法:
    BASE_URL=http://localhost:3000 python3 test/clients/demos.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import urllib.request
import urllib.parse
from pathlib import Path

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3000")
SCRIPT_DIR = Path(__file__).resolve().parent
SYNTAX_DIR = Path(os.environ.get("SYNTAX_DIR") or (SCRIPT_DIR / "demos"))
OUT_DIR = Path(
    os.environ.get("OUT_DIR")
    or (SCRIPT_DIR / "output" / "complex-python")
)
OUT_DIR.mkdir(parents=True, exist_ok=True)


def post_render(syntax: str, fmt: str) -> bytes:
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
            raise RuntimeError(f"{fmt} render returned status {resp.status}")
        return resp.read()


def main() -> int:
    syntax_files = sorted(SYNTAX_DIR.glob("*.txt"))
    if not syntax_files:
        print(f"[py] no .txt files in {SYNTAX_DIR}", file=sys.stderr)
        return 1

    print(f"[py] rendering {len(syntax_files)} templates × {{svg,png}}  -> {OUT_DIR}")
    for f in syntax_files:
        name = f.stem
        syntax = f.read_text(encoding="utf-8")
        for fmt in ("svg", "png"):
            data = post_render(syntax, fmt)
            out_path = OUT_DIR / f"{name}.{fmt}"
            out_path.write_bytes(data)
            print(f"  {name}.{fmt}  200  {len(data)}B")
    return 0


if __name__ == "__main__":
    sys.exit(main())
