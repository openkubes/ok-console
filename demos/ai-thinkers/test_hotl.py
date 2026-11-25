"""Non-mutating checks for local HOTL evidence projection and policy defaults."""
import importlib.util
import json
import tempfile
import unittest
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


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.hotl = load("hotl")

    def test_exact_policy_candidate(self):
        self.assertEqual(self.hotl.EXPECTED, {
            "operation": "deploy", "workload": "nginx", "replicas": 2, "target": "demo"
        })

    def test_trusted_target_pinned(self):
        self.assertEqual((self.hotl.NS, self.hotl.NAME, self.hotl.IMAGE),
                         ("wjax-demo", "wjax-nginx", "nginx:1.27.5-alpine"))


if __name__ == "__main__":
    unittest.main()
