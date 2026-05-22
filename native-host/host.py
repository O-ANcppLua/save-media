#!/usr/bin/env python3
"""savemedia native messaging host — entry point.

Reads length-prefixed JSON requests from stdin, dispatches to handlers,
writes length-prefixed JSON responses to stdout. Capabilities are advertised
in the pong response so the extension can degrade gracefully when ffprobe /
yt-dlp are missing.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from savemedia_host import __version__
from savemedia_host.logging_setup import setup_logger
from savemedia_host.paths import sink_root
from savemedia_host.probe import is_available as probe_available, probe
from savemedia_host.protocol import (
    ProtocolError,
    read_message,
    stdio_streams,
    write_message,
)
from savemedia_host.schema import SchemaError, validate_request
from savemedia_host.sink import SinkError, SinkRegistry
from savemedia_host.ytdlp import (
    build_argv,
    find_output_path,
    is_available as ytdlp_available,
    run as ytdlp_run,
    sha256_file,
)

LOGGER = setup_logger()


def capabilities() -> list[str]:
    caps: list[str] = ["sink"]
    if ytdlp_available():
        caps.append("ytdlp")
    if probe_available():
        caps.append("probe")
    return caps


def handle(msg: dict[str, Any], registry: SinkRegistry) -> dict[str, Any]:
    rtype = msg["type"]
    nonce = msg["nonce"]
    if rtype == "ping":
        return {
            "type": "pong",
            "nonce": nonce,
            "host": "savemedia-host",
            "version": __version__,
            "capabilities": capabilities(),
        }
    if rtype == "download.ytdlp":
        if not ytdlp_available():
            return _error(nonce, "native_host_dependency", "yt-dlp not on PATH")
        output_dir = Path(msg["outputDir"])
        argv = build_argv(msg["url"], msg["quality"], output_dir)
        rc, tail = ytdlp_run(argv, timeout_seconds=3600)
        if rc != 0:
            return _error(nonce, "native_host_protocol", "yt-dlp non-zero exit", detail="\n".join(tail[-40:]))
        output_path = find_output_path(tail, output_dir)
        if output_path is None or not output_path.exists():
            return _error(
                nonce,
                "native_host_protocol",
                "yt-dlp succeeded but no output file detected",
                detail="\n".join(tail[-40:]),
            )
        return {
            "type": "complete",
            "nonce": nonce,
            "outputPath": str(output_path),
            "bytesWritten": output_path.stat().st_size,
            "checksum": sha256_file(output_path),
        }
    if rtype == "sink.open":
        sink = registry.open(msg["filename"], msg.get("expectedSize"))
        return {"type": "sink.opened", "nonce": nonce, "sinkId": sink.sink_id}
    if rtype == "sink.chunk":
        bytes_acked = registry.chunk(msg["sinkId"], msg["offset"], msg["dataB64"])
        return {"type": "sink.ack", "nonce": nonce, "sinkId": msg["sinkId"], "bytesAcked": bytes_acked}
    if rtype == "sink.close":
        final_path, checksum, bytes_written = registry.close(msg["sinkId"], msg["finalChecksum"])
        return {
            "type": "complete",
            "nonce": nonce,
            "outputPath": str(final_path),
            "bytesWritten": bytes_written,
            "checksum": checksum,
        }
    if rtype == "sink.abort":
        discarded = registry.abort(msg["sinkId"])
        return {
            "type": "sink.aborted",
            "nonce": nonce,
            "sinkId": msg["sinkId"],
            "partialBytesDiscarded": discarded,
        }
    if rtype == "probe":
        if not probe_available():
            return _error(nonce, "native_host_dependency", "ffprobe not on PATH")
        try:
            data = probe(msg["url"], timeout_seconds=30)
        except Exception as exc:  # noqa: BLE001 — surface as protocol error
            return _error(nonce, "native_host_timeout", "probe failed", detail=str(exc)[:512])
        return {"type": "probe.result", "nonce": nonce, "data": data}
    return _error(nonce, "native_host_protocol", f"unhandled type: {rtype}")


def _error(nonce: str, code: str, message: str, detail: str = "") -> dict[str, Any]:
    return {
        "type": "error",
        "nonce": nonce,
        "code": code,
        "detail": f"{message}: {detail}" if detail else message,
    }


def main() -> int:
    LOGGER.info("starting savemedia-host v%s, sink root %s", __version__, sink_root())
    registry = SinkRegistry()
    stdin, stdout = stdio_streams()
    while True:
        try:
            msg = read_message(stdin)
        except ProtocolError as exc:
            LOGGER.error("protocol error: %s", exc)
            return 2
        if msg is None:
            LOGGER.info("EOF; shutting down")
            return 0
        try:
            validated = validate_request(msg)
            response = handle(validated, registry)
        except SchemaError as exc:
            response = _error(msg.get("nonce", ""), "native_host_protocol", str(exc))
        except SinkError as exc:
            response = _error(msg.get("nonce", ""), "native_sink_io_error", str(exc))
        except Exception as exc:  # noqa: BLE001 — never crash the host on a single bad message
            LOGGER.exception("handler error")
            response = _error(msg.get("nonce", ""), "native_host_protocol", f"internal error: {exc}")
        try:
            write_message(stdout, response)
        except ProtocolError as exc:
            LOGGER.error("response too large: %s", exc)
            return 3


if __name__ == "__main__":
    sys.exit(main())
