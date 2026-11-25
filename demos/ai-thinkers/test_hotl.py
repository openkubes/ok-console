"""Non-mutating checks for local HOTL evidence projection and policy defaults."""
import importlib.util
import json
import subprocess
import sys
from datetime import datetime, timezone, timedelta
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

BASE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, BASE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DashboardTests(unittest.TestCase):
    def setUp(self):
        self.dashboard = load("dashboard")

    def test_empty_runtime(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.dashboard.read_events(Path(directory) / "missing.jsonl"), ([], 0))

    def test_projection_excludes_sensitive_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "ai-thinkers-evidence.jsonl"
            file.write_text(
                json.dumps({"at": "2026-11-25T00:00:00Z", "event": "AI_PROPOSAL",
                            "model": "llama3.2:latest", "token": "SECRET",
                            "candidate": {"token": "SECRET"}}) + "\n"
                + json.dumps({"event": "HOTL_RECOVERY_VERIFIED",
                              "result": "READY_VERIFIED",
                              "observed": {"ready": 2, "desired": 2, "uid": "hidden"}}) + "\n"
            )
            events, count = self.dashboard.read_events(file)
            self.assertEqual(count, 2)
            self.assertEqual(events[1]["ready"], 2)
            self.assertNotIn("SECRET", json.dumps(events))
            self.assertNotIn("hidden", json.dumps(events))

    def test_symlink_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "evidence.jsonl"
            file.write_text("{}\n")
            link = Path(directory) / "linked.jsonl"
            link.symlink_to(file)
            with self.assertRaises(ValueError):
                self.dashboard.read_events(link)


    def test_heartbeat_status_lifecycle_and_session_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ai-thinkers-status.json"
            now = datetime(2026, 11, 25, tzinfo=timezone.utc)
            events = [{"event": "HOTL_ENABLED", "session": "active"}]
            payload = {
                "session": "active",
                "state": "MONITORING",
                "heartbeat": now.isoformat(),
            }
            path.write_text(json.dumps(payload))
            self.assertEqual(self.dashboard.read_status(path, events, now)["state"], "MONITORING")
            payload["heartbeat"] = (now - timedelta(seconds=20)).isoformat()
            path.write_text(json.dumps(payload))
            self.assertEqual(self.dashboard.read_status(path, events, now)["state"], "UNKNOWN")
            payload["state"] = "STOPPED"
            path.write_text(json.dumps(payload))
            self.assertEqual(self.dashboard.read_status(path, events, now)["state"], "STOPPED")
            payload["state"] = "FAILED_CLOSED"
            path.write_text(json.dumps(payload))
            self.assertEqual(self.dashboard.read_status(path, events, now)["state"], "FAILED_CLOSED")
            payload["session"] = "previous"
            path.write_text(json.dumps(payload))
            self.assertEqual(self.dashboard.read_status(path, events, now)["state"], "UNKNOWN")

    def test_status_symlink_and_invalid_state_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ai-thinkers-status.json"
            link = Path(directory) / "status-link"
            now = datetime(2026, 11, 25, tzinfo=timezone.utc)
            events = [{"event": "HOTL_ENABLED", "session": "active"}]
            path.write_text(json.dumps({
                "session": "active", "state": "AUTHORIZED",
                "heartbeat": now.isoformat(),
                "token": "SECRET",
            }))
            self.assertEqual(self.dashboard.read_status(path, events, now)["state"], "UNKNOWN")
            link.symlink_to(path)
            self.assertEqual(self.dashboard.read_status(link, events, now)["state"], "UNKNOWN")

    def test_latest_session_hides_old_verified_result(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "ai-thinkers-evidence.jsonl"
            items = [
                {"event": "HOTL_ENABLED", "mode": "one-shot"},
                {"event": "HOTL_RECOVERY_VERIFIED", "result": "READY_VERIFIED"},
                {"event": "HOTL_ENABLED", "mode": "one-shot"},
                {"event": "DRIFT_CONFIRMED", "uid": "local"},
            ]
            file.write_text("".join(json.dumps(item) + "\n" for item in items))
            events, count = self.dashboard.read_events(file)
            self.assertEqual(count, 2)
            self.assertEqual([e["event"] for e in events],
                             ["HOTL_ENABLED", "DRIFT_CONFIRMED"])


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.hotl = load("hotl")

    def test_exact_policy_candidate(self):
        self.assertEqual(self.hotl.EXPECTED, {
            "operation": "deploy", "workload": "nginx", "replicas": 2, "target": "demo"
        })

    def test_modes_are_mutually_exclusive(self):
        script = str(BASE / "hotl.py")
        for flags, expected in [
            (["--once", "--always"], "not allowed with argument"),
            ([], "one of the arguments"),
        ]:
            with self.subTest(flags=flags):
                completed = subprocess.run(
                    [sys.executable, script, "--runtime-dir", "/tmp", *flags],
                    capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(completed.returncode, 2)
                self.assertIn(expected, completed.stderr)

    def test_always_requires_explicit_consent(self):
        script = str(BASE / "hotl.py")
        completed = subprocess.run(
            [sys.executable, script, "--enable-hotl", "--always",
             "--runtime-dir", "/tmp"],
            capture_output=True, text=True, timeout=10, env={},
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("explicit AI_THINKERS_HOTL consent", completed.stderr)

    def test_runtime_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "private"
            real.mkdir(mode=0o700)
            link = root / "linked"
            link.symlink_to(real, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "UNSAFE_RUNTIME_SYMLINK"):
                self.hotl.checked_runtime_dir(link)
            self.assertEqual(self.hotl.checked_runtime_dir(real), real)

    def test_secure_audit_append_refuses_symlinks_and_public_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "audit.jsonl"
            link = root / "audit-link"
            target.write_text("safe\\n")
            link.symlink_to(target)
            with self.assertRaises(OSError):
                self.hotl.record(link, "HOTL_ENABLED")
            self.assertEqual(target.read_text(), "safe\\n")
            with self.assertRaisesRegex(RuntimeError, "UNSAFE_DEMO_FILE"):
                self.hotl.record(target, "HOTL_ENABLED")
            target.chmod(0o600)
            self.hotl.record(target, "HOTL_ENABLED")
            self.assertIn("HOTL_ENABLED", target.read_text())

    def test_secure_append_rejects_non_regular_file(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises((OSError, RuntimeError)):
                with self.hotl.secure_append(Path(directory)):
                    pass

    def test_trusted_target_pinned(self):
        self.assertEqual((self.hotl.NS, self.hotl.NAME, self.hotl.IMAGE),
                         ("wjax-demo", "wjax-nginx", "nginx:1.27.5-alpine"))


if __name__ == "__main__":
    unittest.main()
