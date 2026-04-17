from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

try:
    from moviepy.editor import VideoFileClip  # type: ignore
except Exception:  # pragma: no cover
    VideoFileClip = None


logging.basicConfig(
    format="%(asctime)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("bv-servant-backend")

API_VIEW_URL = "https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
API_PLAY_URL = (
    "https://api.bilibili.com/x/player/playurl?"
    "otype=json&fnver=0&fnval=2&player=1&qn=80&bvid={bvid}&cid={cid}"
)
HEADERS = {
    "Referer": "https://www.bilibili.com",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/123.0 Safari/537.36"
    ),
}
DEFAULT_DOWNLOAD_DIR = str(Path.home() / "Downloads")
DOWNLOAD_CHUNK_SIZE = 1024 * 1024
MAX_THREADS = 8


def json_request(url: str) -> dict[str, Any]:
    request = Request(url, headers=HEADERS)
    with urlopen(request, timeout=15) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if payload.get("code") != 0:
        raise ValueError(payload.get("message") or "Bilibili API error")
    return payload["data"]


def sanitize_filename(filename: str) -> str:
    filename = re.sub(r'[\\/:*?"<>|]', "", filename)
    filename = filename.replace(" ", "_")[:255]
    return filename or "bilibili_video"


def ensure_mp4_extension(filename: str) -> str:
    return filename if filename.lower().endswith(".mp4") else f"{filename}.mp4"


def get_cid_and_title(bvid: str, part_index: int) -> dict[str, Any]:
    data = json_request(API_VIEW_URL.format(bvid=quote(bvid)))
    pages = data.get("pages") or []
    if not pages:
        raise ValueError("No pages returned for this BV ID")
    if part_index < 0 or part_index >= len(pages):
        raise ValueError(f"Part index {part_index} is out of range. Max is {len(pages) - 1}.")
    page = pages[part_index]
    return {
        "cid": str(page["cid"]),
        "title": str(data["title"]),
        "part_name": str(page.get("part") or f"P{part_index + 1}"),
        "total_parts": len(pages),
    }


def get_play_url(bvid: str, cid: str) -> str:
    data = json_request(API_PLAY_URL.format(bvid=quote(bvid), cid=quote(cid)))
    durls = data.get("durl") or []
    if not durls or "url" not in durls[0]:
        raise ValueError("Play URL not found")
    return str(durls[0]["url"])


def inspect_media(url: str) -> dict[str, Any]:
    request = Request(url, headers=HEADERS, method="HEAD")
    with urlopen(request, timeout=15) as response:
        headers = response.headers
        return {
            "size": int(headers.get("Content-Length") or 0),
            "supports_range": "bytes" in (headers.get("Accept-Ranges") or "").lower(),
        }


@dataclass
class DownloadJob:
    job_id: str
    bvid: str
    part_index: int
    title: str
    cid: str
    media_url: str
    file_path: str
    threads: int
    convert_mp3: bool
    total_size: int
    supports_range: bool
    status: str = "queued"
    downloaded_bytes: int = 0
    message: str = "Queued"
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    lock: threading.Lock = field(default_factory=threading.Lock)

    @property
    def progress(self) -> float:
        if self.total_size <= 0:
            return 0.0
        return min(100.0, (self.downloaded_bytes / self.total_size) * 100)

    def to_dict(self) -> dict[str, Any]:
        with self.lock:
            return {
                "job_id": self.job_id,
                "status": self.status,
                "progress": round(self.progress, 2),
                "downloaded_bytes": self.downloaded_bytes,
                "total_size": self.total_size,
                "message": self.message,
                "error": self.error,
                "file_path": self.file_path,
                "finished_at": self.finished_at,
                "convert_mp3": self.convert_mp3,
            }

    def update(self, **kwargs: Any) -> None:
        with self.lock:
            for key, value in kwargs.items():
                setattr(self, key, value)


class JobStore:
    def __init__(self) -> None:
        self._jobs: dict[str, DownloadJob] = {}
        self._lock = threading.Lock()

    def add(self, job: DownloadJob) -> None:
        with self._lock:
            self._jobs[job.job_id] = job

    def get(self, job_id: str) -> DownloadJob | None:
        with self._lock:
            return self._jobs.get(job_id)


JOB_STORE = JobStore()


def download_range(job: DownloadJob, start: int, end: int, part_file: str) -> None:
    headers = HEADERS.copy()
    headers["Range"] = f"bytes={start}-{end}"
    request = Request(job.media_url, headers=headers)
    with urlopen(request, timeout=30) as response, open(part_file, "wb") as handle:
        while not job.cancel_event.is_set():
            chunk = response.read(DOWNLOAD_CHUNK_SIZE)
            if not chunk:
                break
            handle.write(chunk)
            with job.lock:
                job.downloaded_bytes += len(chunk)


def cleanup_parts(file_path: str, threads: int) -> None:
    for index in range(threads):
        part_file = f"{file_path}.part{index}"
        if os.path.exists(part_file):
            os.remove(part_file)


def merge_parts(file_path: str, threads: int) -> None:
    with open(file_path, "wb") as target:
        for index in range(threads):
            part_file = f"{file_path}.part{index}"
            with open(part_file, "rb") as source:
                target.write(source.read())
            os.remove(part_file)


def download_single(job: DownloadJob) -> None:
    request = Request(job.media_url, headers=HEADERS)
    with urlopen(request, timeout=30) as response, open(job.file_path, "wb") as handle:
        while not job.cancel_event.is_set():
            chunk = response.read(DOWNLOAD_CHUNK_SIZE)
            if not chunk:
                break
            handle.write(chunk)
            with job.lock:
                job.downloaded_bytes += len(chunk)


def convert_to_mp3(file_path: str) -> str:
    if VideoFileClip is None:
        raise RuntimeError("moviepy is not available in this Python environment")

    video = VideoFileClip(file_path)
    audio = video.audio
    if audio is None:
        video.close()
        raise RuntimeError("The downloaded file does not contain an audio stream")
    mp3_path = str(Path(file_path).with_suffix(".mp3"))
    try:
        audio.write_audiofile(mp3_path)
    finally:
        audio.close()
        video.close()
    return mp3_path


def run_download_job(job: DownloadJob) -> None:
    try:
        Path(job.file_path).parent.mkdir(parents=True, exist_ok=True)
        job.update(status="downloading", message="Download in progress")

        if job.supports_range and job.total_size > 0 and job.threads > 1:
            segment_size = max(1, job.total_size // job.threads)
            threads: list[threading.Thread] = []
            for index in range(job.threads):
                start = index * segment_size
                end = job.total_size - 1 if index == job.threads - 1 else (start + segment_size - 1)
                part_file = f"{job.file_path}.part{index}"
                thread = threading.Thread(
                    target=download_range,
                    args=(job, start, end, part_file),
                    daemon=True,
                )
                thread.start()
                threads.append(thread)

            for thread in threads:
                thread.join()

            if job.cancel_event.is_set():
                cleanup_parts(job.file_path, job.threads)
                if os.path.exists(job.file_path):
                    os.remove(job.file_path)
                job.update(status="cancelled", message="Download cancelled", finished_at=time.time())
                return

            merge_parts(job.file_path, job.threads)
        else:
            download_single(job)
            if job.cancel_event.is_set():
                if os.path.exists(job.file_path):
                    os.remove(job.file_path)
                job.update(status="cancelled", message="Download cancelled", finished_at=time.time())
                return

        message = f"Saved to {job.file_path}"
        if job.convert_mp3:
            mp3_path = convert_to_mp3(job.file_path)
            message = f"Saved video and converted audio to {mp3_path}"

        job.update(status="finished", message=message, finished_at=time.time())
    except Exception as error:
        logger.exception("Download job failed")
        cleanup_parts(job.file_path, job.threads)
        if os.path.exists(job.file_path):
            try:
                os.remove(job.file_path)
            except OSError:
                pass
        job.update(
            status="error",
            error=str(error),
            message=f"Download failed: {error}",
            finished_at=time.time(),
        )


class BvServantHandler(BaseHTTPRequestHandler):
    server_version = "BVServantBackend/1.0"

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        super().end_headers()

    def log_message(self, fmt: str, *args: Any) -> None:
        logger.info("%s - %s", self.address_string(), fmt % args)

    def _json_response(self, payload: dict[str, Any], status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(content_length) if content_length else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self._json_response(
                {
                    "ok": True,
                    "default_download_dir": DEFAULT_DOWNLOAD_DIR,
                    "mp3_available": VideoFileClip is not None,
                }
            )
            return

        if parsed.path.startswith("/api/jobs/"):
            job_id = parsed.path.rsplit("/", 1)[-1]
            job = JOB_STORE.get(job_id)
            if not job:
                self._json_response({"ok": False, "error": "Job not found"}, status=HTTPStatus.NOT_FOUND)
                return
            self._json_response({"ok": True, "job": job.to_dict()})
            return

        self._json_response({"ok": False, "error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            payload = self._read_json_body()
        except json.JSONDecodeError:
            self._json_response({"ok": False, "error": "Invalid JSON body"}, status=HTTPStatus.BAD_REQUEST)
            return

        try:
            if parsed.path == "/api/metadata":
                self.handle_metadata(payload)
                return
            if parsed.path == "/api/download":
                self.handle_download(payload)
                return
            if parsed.path == "/api/cancel":
                self.handle_cancel(payload)
                return
        except ValueError as error:
            self._json_response({"ok": False, "error": str(error)}, status=HTTPStatus.BAD_REQUEST)
            return
        except (HTTPError, URLError) as error:
            self._json_response({"ok": False, "error": str(error)}, status=HTTPStatus.BAD_GATEWAY)
            return
        except Exception as error:
            logger.exception("Unhandled backend error")
            self._json_response({"ok": False, "error": str(error)}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        self._json_response({"ok": False, "error": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def handle_metadata(self, payload: dict[str, Any]) -> None:
        bvid = str(payload.get("bvid") or "").strip()
        if not bvid.startswith("BV"):
            raise ValueError("Please provide a valid BV ID")
        part_index = int(payload.get("part") or 0)
        filename_override = str(payload.get("filename") or "").strip()

        meta = get_cid_and_title(bvid, part_index)
        media_url = get_play_url(bvid, meta["cid"])
        inspection = inspect_media(media_url)
        filename = ensure_mp4_extension(sanitize_filename(filename_override or meta["title"]))
        self._json_response(
            {
                "ok": True,
                "metadata": {
                    "bvid": bvid,
                    "cid": meta["cid"],
                    "title": meta["title"],
                    "part_index": part_index,
                    "part_name": meta["part_name"],
                    "total_parts": meta["total_parts"],
                    "media_url": media_url,
                    "size": inspection["size"],
                    "supports_range": inspection["supports_range"],
                    "filename": filename,
                    "default_directory": DEFAULT_DOWNLOAD_DIR,
                    "mp3_available": VideoFileClip is not None,
                },
            }
        )

    def handle_download(self, payload: dict[str, Any]) -> None:
        bvid = str(payload.get("bvid") or "").strip()
        cid = str(payload.get("cid") or "").strip()
        media_url = str(payload.get("media_url") or "").strip()
        title = str(payload.get("title") or "bilibili_video").strip()
        filename = ensure_mp4_extension(sanitize_filename(str(payload.get("filename") or title)))
        directory = str(payload.get("directory") or DEFAULT_DOWNLOAD_DIR).strip() or DEFAULT_DOWNLOAD_DIR
        threads = max(1, min(MAX_THREADS, int(payload.get("threads") or 1)))
        convert_mp3 = bool(payload.get("convert_mp3"))
        part_index = int(payload.get("part") or 0)
        total_size = int(payload.get("size") or 0)
        supports_range = bool(payload.get("supports_range"))

        if not bvid or not cid or not media_url:
            raise ValueError("Missing required download metadata")

        file_path = str(Path(directory) / filename)
        job = DownloadJob(
            job_id=uuid.uuid4().hex,
            bvid=bvid,
            part_index=part_index,
            title=title,
            cid=cid,
            media_url=media_url,
            file_path=file_path,
            threads=threads,
            convert_mp3=convert_mp3,
            total_size=total_size,
            supports_range=supports_range,
        )
        JOB_STORE.add(job)
        threading.Thread(target=run_download_job, args=(job,), daemon=True).start()
        self._json_response({"ok": True, "job": job.to_dict()})

    def handle_cancel(self, payload: dict[str, Any]) -> None:
        job_id = str(payload.get("job_id") or "").strip()
        if not job_id:
            raise ValueError("job_id is required")
        job = JOB_STORE.get(job_id)
        if not job:
            raise ValueError("Job not found")
        job.cancel_event.set()
        job.update(status="cancelling", message="Cancellation requested")
        self._json_response({"ok": True, "job": job.to_dict()})


def main(host: str = "127.0.0.1", port: int = 8765) -> None:
    server = ThreadingHTTPServer((host, port), BvServantHandler)
    logger.info("BV Servant backend listening on http://%s:%s", host, port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down backend")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
