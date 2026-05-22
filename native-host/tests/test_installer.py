import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from savemedia_host import installer


def make_target(tmp_path: Path, flavor: str = "chromium") -> installer.BrowserTarget:
    return installer.BrowserTarget(
        vendor="Test Browser",
        short="test",
        flavor=flavor,
        manifest_dir_macos=tmp_path / "macos/Library/Application Support/Test/NativeMessagingHosts",
        manifest_dir_linux=tmp_path / "linux/.config/test/NativeMessagingHosts",
        windows_registry_key=r"Software\Test\NativeMessagingHosts\com.savemedia.host",
    )


@pytest.fixture()
def fake_host(tmp_path: Path) -> Path:
    host = tmp_path / "savemedia-host"
    host.write_text("#!/bin/sh\necho fake\n")
    host.chmod(0o755)
    return host


def test_manifest_payload_chromium_uses_allowed_origins(tmp_path: Path, fake_host: Path):
    target = make_target(tmp_path, "chromium")
    payload = installer.manifest_payload(fake_host, target)
    assert payload["name"] == installer.HOST_NAME
    assert payload["type"] == "stdio"
    assert "allowed_origins" in payload
    assert payload["allowed_origins"] == [f"chrome-extension://{installer.EXTENSION_ID_CHROMIUM}/"]
    assert "allowed_extensions" not in payload


def test_manifest_payload_firefox_uses_allowed_extensions(tmp_path: Path, fake_host: Path):
    target = make_target(tmp_path, "firefox")
    payload = installer.manifest_payload(fake_host, target)
    assert payload["allowed_extensions"] == [installer.EXTENSION_ID_FIREFOX]
    assert "allowed_origins" not in payload


def test_write_manifest_writes_json_under_browser_support_dir(tmp_path: Path, fake_host: Path, monkeypatch):
    monkeypatch.setattr(installer.platform, "system", lambda: "Darwin")
    target = make_target(tmp_path, "chromium")
    written = installer.write_manifest(target, fake_host)
    assert written.exists()
    payload = json.loads(written.read_text())
    assert payload["name"] == installer.HOST_NAME
    assert payload["path"] == str(fake_host.resolve())


def test_remove_manifest_round_trip(tmp_path: Path, fake_host: Path, monkeypatch):
    monkeypatch.setattr(installer.platform, "system", lambda: "Darwin")
    target = make_target(tmp_path, "chromium")
    installer.write_manifest(target, fake_host)
    assert installer.remove_manifest(target) is True
    assert installer.remove_manifest(target) is False


def test_detect_browsers_filters_by_existing_support_dir(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(installer.platform, "system", lambda: "Darwin")
    # Only Chrome's directory exists; Edge + Firefox should be filtered out.
    chrome_only = installer.TARGETS[0].manifest_dir_macos.parent
    seen: list[Path] = []
    def exists(p: Path) -> bool:
        seen.append(p)
        return p == chrome_only
    found = installer.detect_browsers(target_dir_exists=exists)
    assert [t.short for t in found] == ["chrome"]


def test_smoketest_ping_pong_against_real_host(tmp_path: Path):
    """Wrap host.py in a launcher script and let installer.smoketest hit it.

    This exercises the real protocol framing through the installer's
    own subprocess code path without needing a PyInstaller binary in CI.
    """
    host_script = Path(__file__).resolve().parent.parent / "host.py"
    launcher = tmp_path / "launcher.sh"
    launcher.write_text(f"#!/bin/sh\nexec {sys.executable} {host_script} \"$@\"\n")
    launcher.chmod(0o755)
    ok, detail = installer.smoketest(launcher)
    assert ok, detail
    assert "capabilities" in detail


def test_main_help_when_no_args(capsys):
    rc = installer.main([])
    assert rc == 1
    out = capsys.readouterr().out
    assert "install" in out
    assert "uninstall" in out
