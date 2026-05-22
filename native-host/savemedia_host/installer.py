"""Cross-platform installer for the savemedia native messaging host.

Browsers register native hosts via per-vendor JSON manifests (macOS, Linux)
or per-vendor registry keys (Windows). This module discovers installed
browsers, writes the right manifest in the right place for each, and
performs a smoke-test handshake by spawning the host with a `ping` request.
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import struct
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

HOST_NAME = "com.savemedia.host"
EXTENSION_ID_CHROMIUM = "savemediaextensionidplaceholder0"  # filled in at packaging
EXTENSION_ID_FIREFOX = "savemedia@ancplua.dev"


@dataclass(frozen=True)
class BrowserTarget:
    vendor: str               # "Google Chrome", "Microsoft Edge", "Mozilla Firefox"
    short: str                # "chrome", "edge", "firefox"
    flavor: str               # "chromium" or "firefox"
    manifest_dir_macos: Path
    manifest_dir_linux: Path
    windows_registry_key: str | None  # HKCU subkey path; None on POSIX-only

    @property
    def is_chromium(self) -> bool:
        return self.flavor == "chromium"


TARGETS: tuple[BrowserTarget, ...] = (
    BrowserTarget(
        vendor="Google Chrome",
        short="chrome",
        flavor="chromium",
        manifest_dir_macos=Path.home() / "Library/Application Support/Google/Chrome/NativeMessagingHosts",
        manifest_dir_linux=Path.home() / ".config/google-chrome/NativeMessagingHosts",
        windows_registry_key=r"Software\Google\Chrome\NativeMessagingHosts\\" + HOST_NAME,
    ),
    BrowserTarget(
        vendor="Microsoft Edge",
        short="edge",
        flavor="chromium",
        manifest_dir_macos=Path.home() / "Library/Application Support/Microsoft Edge/NativeMessagingHosts",
        manifest_dir_linux=Path.home() / ".config/microsoft-edge/NativeMessagingHosts",
        windows_registry_key=r"Software\Microsoft\Edge\NativeMessagingHosts\\" + HOST_NAME,
    ),
    BrowserTarget(
        vendor="Mozilla Firefox",
        short="firefox",
        flavor="firefox",
        manifest_dir_macos=Path.home() / "Library/Application Support/Mozilla/NativeMessagingHosts",
        manifest_dir_linux=Path.home() / ".mozilla/native-messaging-hosts",
        windows_registry_key=r"Software\Mozilla\NativeMessagingHosts\\" + HOST_NAME,
    ),
)


def manifest_path_for(target: BrowserTarget) -> Path:
    system = platform.system()
    if system == "Darwin":
        return target.manifest_dir_macos / f"{HOST_NAME}.json"
    if system == "Linux":
        return target.manifest_dir_linux / f"{HOST_NAME}.json"
    raise NotImplementedError(f"file-based manifest path not used on {system}")


def manifest_payload(host_path: Path, target: BrowserTarget) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": HOST_NAME,
        "description": "savemedia native messaging host",
        "path": str(host_path),
        "type": "stdio",
    }
    if target.flavor == "chromium":
        payload["allowed_origins"] = [f"chrome-extension://{EXTENSION_ID_CHROMIUM}/"]
    else:
        payload["allowed_extensions"] = [EXTENSION_ID_FIREFOX]
    return payload


def detect_browsers(target_dir_exists: callable[[Path], bool] = Path.exists) -> list[BrowserTarget]:
    """Return browsers whose vendor support directory exists on this machine."""
    system = platform.system()
    found: list[BrowserTarget] = []
    for t in TARGETS:
        if system == "Darwin":
            parent = t.manifest_dir_macos.parent
        elif system == "Linux":
            parent = t.manifest_dir_linux.parent
        else:
            parent = Path(t.windows_registry_key) if t.windows_registry_key else Path(".")
        if target_dir_exists(parent):
            found.append(t)
    return found


def write_manifest(target: BrowserTarget, host_path: Path) -> Path:
    """Write the native messaging JSON manifest. Returns the file written.

    On Windows this writes to the registry instead and returns a synthetic
    Path describing the HKCU key for logging purposes.
    """
    payload = manifest_payload(host_path.resolve(), target)
    system = platform.system()
    if system == "Windows":
        return _windows_register(target, host_path, payload)
    out = manifest_path_for(target)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return out


def _windows_register(target: BrowserTarget, host_path: Path, payload: dict[str, object]) -> Path:
    if target.windows_registry_key is None:
        raise NotImplementedError(f"no windows registry key for {target.short}")
    # Write the manifest JSON next to the host binary and point the registry
    # key at it (the Windows native-messaging API reads the file referenced
    # by the registry's default value).
    manifest_file = host_path.with_name(f"{HOST_NAME}.json")
    manifest_file.parent.mkdir(parents=True, exist_ok=True)
    manifest_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    try:
        import winreg  # type: ignore[import-untyped]
    except ImportError as exc:
        raise RuntimeError("winreg unavailable; are you on Windows?") from exc
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, target.windows_registry_key) as key:
        winreg.SetValueEx(key, "", 0, winreg.REG_SZ, str(manifest_file))
    return Path(f"HKCU\\{target.windows_registry_key}")


def remove_manifest(target: BrowserTarget) -> bool:
    """Remove the manifest / registry key for one target. Returns True if removed."""
    system = platform.system()
    if system == "Windows":
        return _windows_unregister(target)
    out = manifest_path_for(target)
    if out.exists():
        out.unlink()
        return True
    return False


def _windows_unregister(target: BrowserTarget) -> bool:
    if target.windows_registry_key is None:
        return False
    try:
        import winreg  # type: ignore[import-untyped]
    except ImportError:
        return False
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, target.windows_registry_key)
        return True
    except FileNotFoundError:
        return False


def smoketest(host_path: Path, *, timeout_seconds: float = 5.0) -> tuple[bool, str]:
    """Spawn the host and exchange ping/pong. Returns (success, detail)."""
    nonce = "installer-smoketest"
    request = json.dumps({"type": "ping", "nonce": nonce, "version": "installer"}).encode("utf-8")
    framed = struct.pack("<I", len(request)) + request
    proc = subprocess.Popen(
        [str(host_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(framed)
        proc.stdin.close()
        try:
            out = proc.stdout.read()
        finally:
            proc.wait(timeout=timeout_seconds)
        if not out or len(out) < 4:
            return False, "no response from host"
        (length,) = struct.unpack("<I", out[:4])
        body = out[4 : 4 + length]
        response = json.loads(body.decode("utf-8"))
        if response.get("type") != "pong" or response.get("nonce") != nonce:
            return False, f"unexpected response: {response}"
        return True, f"capabilities: {response.get('capabilities', [])}"
    except Exception as exc:  # noqa: BLE001
        return False, f"smoketest failed: {exc}"


def dependency_status() -> dict[str, bool]:
    return {
        "yt-dlp": shutil.which("yt-dlp") is not None,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "ffprobe": shutil.which("ffprobe") is not None,
    }


def main(argv: Iterable[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    if not args:
        return _print_help()
    command = args[0]
    if command == "install":
        host = Path(args[1]) if len(args) >= 2 else Path(sys.argv[0]).resolve()
        return _cmd_install(host)
    if command == "uninstall":
        return _cmd_uninstall()
    if command == "status":
        return _cmd_status()
    if command == "deps":
        return _cmd_deps()
    return _print_help()


def _print_help() -> int:
    print(__doc__ or "savemedia-host installer")
    print("\nusage: install [PATH_TO_HOST_BINARY] | uninstall | status | deps")
    return 1


def _cmd_install(host_path: Path) -> int:
    print(f"[1/5] Detecting browsers")
    targets = detect_browsers()
    if not targets:
        print("  no supported browsers found; aborting")
        return 2
    for t in targets:
        print(f"  - {t.vendor}")
    print(f"[2/5] Checking dependencies")
    deps = dependency_status()
    for name, ok in deps.items():
        print(f"  - {name}: {'OK' if ok else 'MISSING'}")
    print(f"[3/5] Resolving host path: {host_path}")
    if not host_path.exists():
        print(f"  ! {host_path} does not exist")
        return 3
    print(f"[4/5] Writing registrations")
    for t in targets:
        out = write_manifest(t, host_path)
        print(f"  - {t.short}: {out}")
    print(f"[5/5] Smoke-testing host (ping/pong)")
    ok, detail = smoketest(host_path)
    print(f"  - {'OK' if ok else 'FAIL'}: {detail}")
    return 0 if ok else 4


def _cmd_uninstall() -> int:
    removed: list[str] = []
    for t in TARGETS:
        if remove_manifest(t):
            removed.append(t.short)
    print(f"removed: {removed}")
    return 0


def _cmd_status() -> int:
    targets = detect_browsers()
    print(f"detected browsers: {[t.short for t in targets]}")
    return 0


def _cmd_deps() -> int:
    for name, ok in dependency_status().items():
        print(f"{name}: {'OK' if ok else 'MISSING'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
