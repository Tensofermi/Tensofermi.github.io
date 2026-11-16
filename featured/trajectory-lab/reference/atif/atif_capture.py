"""Hash-verified, path-confined reads of per-call capture files.

An ATIF file may ship sidecars (``captures/request-001/chat.request.body`` and
friends) next to itself. Those sidecars are the only evidence of what a request
actually contained, so they are read only when:

* the ATIF was loaded from a real directory (uploads have no sidecars),
* the reference is a relative path without ``..`` or symlinks anywhere,
* the resolved path stays inside that directory, and
* the file's SHA256 equals the value recorded in the ATIF.

Anything else raises :class:`CaptureError`; callers surface the message instead
of guessing. This module never writes and never follows a reference supplied by
the browser: callers pass references taken from the already-parsed ATIF.
"""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

SHA256 = re.compile(r"[0-9a-f]{64}")
MAX_BYTES = 32 * 1024 * 1024


class CaptureError(ValueError):
    """A capture reference is unusable; the message is safe to show to a user."""


class CaptureStore:
    def __init__(self, directory):
        self.directory = Path(directory).resolve() if directory else None

    @property
    def available(self):
        return self.directory is not None and self.directory.is_dir()

    def _require(self):
        if not self.available:
            raise CaptureError("该轨迹没有可读取的捕获目录（上传模式不附带 sidecar）")

    def path(self, reference):
        """Resolve a reference to a confined path without reading it."""
        self._require()
        if not isinstance(reference, dict):
            raise CaptureError("捕获引用必须是对象")
        name = reference.get("path")
        expected = str(reference.get("sha256") or "")
        if not isinstance(name, str) or not name:
            raise CaptureError("捕获引用缺少 path")
        if not SHA256.fullmatch(expected):
            raise CaptureError("捕获引用缺少合法的 SHA256")
        relative = Path(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise CaptureError("捕获文件路径超出轨迹目录")
        path = self.directory
        for part in relative.parts:
            path = path / part
            if path.is_symlink():
                raise CaptureError("捕获文件不能经过符号链接")
        path = path.resolve()
        if not path.is_relative_to(self.directory):
            raise CaptureError("捕获文件路径超出轨迹目录")
        if not path.is_file():
            raise CaptureError(f"捕获文件不存在：{name}")
        return path, expected

    def verify(self, reference):
        """Read once, check the hash, and report metadata."""
        path, expected = self.path(reference)
        size = path.stat().st_size
        if size > MAX_BYTES:
            raise CaptureError(f"捕获文件超过 {MAX_BYTES // (1024 * 1024)} MiB，未加载")
        raw = path.read_bytes()
        actual = hashlib.sha256(raw).hexdigest()
        if actual != expected:
            raise CaptureError(f"捕获文件 SHA256 不匹配：{reference.get('path')}")
        return {"path": reference.get("path"), "sha256": actual, "bytes": len(raw), "raw": raw}

    def bytes(self, reference):
        return self.verify(reference)["raw"]

    def text(self, reference):
        raw = self.bytes(reference)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise CaptureError(f"捕获文件不是 UTF-8 原文：{reference.get('path')}") from exc

    def json(self, reference):
        text = self.text(reference)
        try:
            return json.loads(text)
        except ValueError as exc:
            raise CaptureError(f"捕获文件不是合法 JSON：{reference.get('path')}") from exc
