"""yt-dlp argv builder + runner. No shell=True; explicit argv only."""
from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
from pathlib import Path
from typing import Iterable

from .paths import sanitize_filename

# yt-dlp prints one of these lines on success. We parse the actual output
# file out of stdout so the host can report a real path to the extension,
# not just the output directory.
_DESTINATION_RE = re.compile(
    r'^(?:\[download\] Destination: |\[Merger\] Merging formats into "|\[download\] (?:Already )?\S+ has already been downloaded(?:\.| as )?)(.+?)(?:"|$)',
)
_DELETING_ORIGINAL_RE = re.compile(r'^Deleting original file (.+?)(?: \(pass -k to keep\))?$')

# Quality hints accepted from the extension.
QUALITY_TO_FORMAT = {
    "best": "bestvideo[height<=2160]+bestaudio/best",
    "2160p": "bestvideo[height<=2160]+bestaudio/best[height<=2160]",
    "1440p": "bestvideo[height<=1440]+bestaudio/best[height<=1440]",
    "1080p": "bestvideo[height<=1080]+bestaudio/best[height<=1080]",
    "720p": "bestvideo[height<=720]+bestaudio/best[height<=720]",
}


def build_argv(
    url: str,
    quality: str,
    output_dir: Path,
    *,
    binary: str = "yt-dlp",
    template: str = "%(title).200B [%(id)s].%(ext)s",
) -> list[str]:
    """Build the explicit argv list for a yt-dlp invocation.

    No shell=True ever. We do not pass user-controlled strings outside the
    `--output` template, which yt-dlp itself sanitises against its own
    rules.
    """
    fmt = QUALITY_TO_FORMAT.get(quality, QUALITY_TO_FORMAT["best"])
    safe_output_dir = Path(output_dir).resolve()
    safe_output_dir.mkdir(parents=True, exist_ok=True)
    return [
        binary,
        "--no-call-home",
        "--no-progress",
        "--newline",
        "--restrict-filenames",
        "--no-warnings",
        "--format", fmt,
        "--merge-output-format", "mp4",
        "--output", str(safe_output_dir / template),
        url,
    ]


def is_available(binary: str = "yt-dlp") -> bool:
    return shutil.which(binary) is not None


def run(
    argv: list[str],
    timeout_seconds: float,
    on_line: callable[[str], None] | None = None,
) -> tuple[int, list[str]]:
    """Run yt-dlp, streaming stdout to `on_line` (if any), returning rc + tail."""
    tail: list[str] = []
    proc = subprocess.Popen(
        argv,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            if on_line is not None:
                on_line(line)
            tail.append(line)
            if len(tail) > 500:
                tail = tail[-500:]
        rc = proc.wait(timeout=timeout_seconds)
        return rc, tail
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise
    finally:
        if proc.stdout is not None:
            proc.stdout.close()


def safe_output_name(title: str) -> str:
    return sanitize_filename(title)


def find_output_path(tail: Iterable[str], output_dir: Path) -> Path | None:
    """Walk yt-dlp's stdout tail in order and return the final output file.

    yt-dlp prints multiple `Destination:` lines (one per format being
    downloaded) and may merge them at the end into a single file via
    `[Merger] Merging formats into "<final>"`. We honour the *last*
    Merger line if present, otherwise the last Destination line, then
    drop any file that was explicitly deleted along the way.
    """
    merged: str | None = None
    destinations: list[str] = []
    deleted: set[str] = set()
    for line in tail:
        m = _DESTINATION_RE.match(line)
        if m:
            candidate = m.group(1).strip()
            if line.startswith("[Merger]"):
                merged = candidate
            else:
                destinations.append(candidate)
        d = _DELETING_ORIGINAL_RE.match(line)
        if d:
            deleted.add(d.group(1).strip())

    candidates: list[str] = []
    if merged is not None:
        candidates.append(merged)
    for dest in reversed(destinations):
        if dest not in deleted:
            candidates.append(dest)
    for c in candidates:
        path = Path(c)
        if not path.is_absolute():
            path = output_dir / path
        if path.exists():
            return path
    return None


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    """Streaming sha256 so we don't materialise huge files into memory."""
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(chunk_size), b""):
            h.update(chunk)
    return h.hexdigest()
