import hashlib
from pathlib import Path

from savemedia_host.ytdlp import (
    QUALITY_TO_FORMAT,
    build_argv,
    find_output_path,
    safe_output_name,
    sha256_file,
)


def test_build_argv_uses_quality_format(tmp_path: Path):
    argv = build_argv("https://example.com/v", "1080p", tmp_path)
    assert argv[0] == "yt-dlp"
    assert "--format" in argv
    assert argv[argv.index("--format") + 1] == QUALITY_TO_FORMAT["1080p"]
    assert argv[-1] == "https://example.com/v"


def test_build_argv_defaults_to_best(tmp_path: Path):
    argv = build_argv("https://example.com/v", "weird-quality", tmp_path)
    assert argv[argv.index("--format") + 1] == QUALITY_TO_FORMAT["best"]


def test_build_argv_never_invokes_shell(tmp_path: Path):
    # The host runs yt-dlp via explicit argv; assert nothing in the argv looks
    # like a shell metacharacter sequence that would matter if it were ever
    # shell-evaluated (paranoia: future regression guard).
    argv = build_argv("https://example.com/v?a=1&b=2", "best", tmp_path)
    joined = " ".join(argv)
    for forbidden in (";", "|", "`", "&&", "$("):
        assert forbidden not in joined.replace("&b=2", ""), f"unexpected {forbidden!r} in argv"


def test_build_argv_creates_output_dir(tmp_path: Path):
    target = tmp_path / "videos"
    build_argv("https://x", "best", target)
    assert target.exists()


def test_safe_output_name_strips_path_separators():
    assert "/" not in safe_output_name("a/b")
    assert "\\" not in safe_output_name("a\\b")


def test_find_output_path_picks_the_merged_file(tmp_path: Path):
    merged = tmp_path / "Final Video [abc123].mp4"
    merged.write_bytes(b"final")
    tail = [
        "[download] Destination: Final Video [abc123].f137.mp4",
        "[download] Destination: Final Video [abc123].f140.m4a",
        '[Merger] Merging formats into "Final Video [abc123].mp4"',
        "Deleting original file Final Video [abc123].f137.mp4",
        "Deleting original file Final Video [abc123].f140.m4a",
    ]
    assert find_output_path(tail, tmp_path) == merged


def test_find_output_path_falls_back_to_single_destination(tmp_path: Path):
    target = tmp_path / "clip.mp4"
    target.write_bytes(b"x")
    tail = ["[download] Destination: clip.mp4"]
    assert find_output_path(tail, tmp_path) == target


def test_find_output_path_skips_files_that_were_deleted(tmp_path: Path):
    keep = tmp_path / "keep.mp4"
    keep.write_bytes(b"k")
    tail = [
        "[download] Destination: keep.mp4",
        "[download] Destination: drop.mp4",
        "Deleting original file drop.mp4",
    ]
    assert find_output_path(tail, tmp_path) == keep


def test_find_output_path_returns_none_when_nothing_landed(tmp_path: Path):
    tail = ["[download] Destination: never-existed.mp4"]
    assert find_output_path(tail, tmp_path) is None


def test_sha256_file_matches_hashlib(tmp_path: Path):
    target = tmp_path / "data.bin"
    payload = b"hello savemedia" * 1024
    target.write_bytes(payload)
    assert sha256_file(target) == hashlib.sha256(payload).hexdigest()
