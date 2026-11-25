#!/usr/bin/env python3
"""AI Thinkerers HOTL local-kind spike. NOT production automation.

Explicit enablement; exact workload guard; AI only proposes; atomic Kubernetes
preconditions; separate evidence; Ctrl-C stops future attempts.
"""
import argparse
import fcntl
import json
import threading
import uuid
import os
import stat
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

NS = "wjax-demo"
NAME = "wjax-nginx"
IMAGE = "nginx:1.27.5-alpine"
EXPECTED = {"operation": "deploy", "workload": "nginx", "replicas": 2, "target": "demo"}
CONSENT = "I_ACCEPT_LOCAL_KIND_ONLY"
HEARTBEAT_SECONDS = 2


class SupervisorStatus:
    """Best-effort local status only: no credentials or authorization semantics."""

    def __init__(self, runtime, mode):
        self.path = runtime / "ai-thinkers-status.json"
        self.session = uuid.uuid4().hex
        self.mode = mode
        self.pid = os.getpid()
        self.started = datetime.now(timezone.utc).isoformat()
        self.state = "MONITORING"
        self.lock = threading.Lock()
        self.done = threading.Event()
        self.error = None
        self.thread = None

    def write(self):
        with self.lock:
            item = {
                "session": self.session,
                "mode": self.mode,
                "pid": self.pid,
                "started": self.started,
                "heartbeat": datetime.now(timezone.utc).isoformat(),
                "state": self.state,
            }
            # Never follow a symlink or overwrite an unrelated existing file.
            if self.path.is_symlink():
                raise RuntimeError("UNSAFE_STATUS_SYMLINK")
            temp = self.path.parent / ("." + self.path.name + "." + self.session + ".tmp")
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    json.dump(item, stream, sort_keys=True)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temp, self.path)
            finally:
                if temp.exists():
                    temp.unlink()

    def set(self, state):
        with self.lock:
            self.state = state
        self.write()

    def start(self):
        self.write()
        self.thread = threading.Thread(target=self._heartbeat, daemon=True)
        self.thread.start()

    def _heartbeat(self):
        while not self.done.wait(HEARTBEAT_SECONDS):
            try:
                self.write()
            except Exception as exc:
                self.error = exc
                return

    def check(self):
        if self.error is not None:
            raise RuntimeError("STATUS_HEARTBEAT_FAILED") from self.error

    def stop(self, state):
        self.done.set()
        if self.thread:
            self.thread.join(timeout=3)
        self.set(state)




def secure_append(path):
    """Append/create a private regular file without following the final symlink."""
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or stat.S_IMODE(info.st_mode) & 0o077):
            raise RuntimeError("UNSAFE_DEMO_FILE")
        return os.fdopen(fd, "a", encoding="utf-8")
    except BaseException:
        os.close(fd)
        raise


def checked_runtime_dir(raw):
    """Reject symlink components before resolving the private runtime path."""
    candidate = Path(raw).expanduser().absolute()
    if any(component.is_symlink() for component in (candidate, *candidate.parents)):
        raise RuntimeError("UNSAFE_RUNTIME_SYMLINK")
    home = candidate.resolve(strict=True)
    if not home.is_dir() or stat.S_IMODE(home.stat().st_mode) & 0o077:
        raise RuntimeError("UNSAFE_RUNTIME_PERMISSIONS")
    return home


def record(path, event, **kwargs):
    item = {"at": datetime.now(timezone.utc).isoformat(), "event": event, **kwargs}
    with secure_append(path) as f:
        f.write(json.dumps(item, sort_keys=True) + "\n")
        f.flush()
        os.fsync(f.fileno())
    print(json.dumps(item, sort_keys=True), flush=True)


def run_kubectl(config, *args):
    p = subprocess.run(
        ["kubectl", "--kubeconfig", str(config), "-n", NS, *args],
        capture_output=True, text=True, timeout=15, check=False,
    )
    if p.returncode:
        raise RuntimeError("kubectl operation failed; exit=" + str(p.returncode))
    return p.stdout


def check_target(config):
    """Fail closed unless dedicated kubeconfig targets the local kind demo."""
    p = subprocess.run(
        ["kubectl", "--kubeconfig", str(config), "config", "view", "--minify", "-o", "json"],
        capture_output=True, text=True, timeout=10, check=True,
    )
    data = json.loads(p.stdout)
    contexts = data.get("contexts", [])
    clusters = data.get("clusters", [])
    if len(contexts) != 1 or len(clusters) != 1:
        raise RuntimeError("AMBIGUOUS_KUBECONFIG")
    ctx = contexts[0]["context"]
    cluster = clusters[0]["cluster"]
    endpoint = urlsplit(cluster.get("server", ""))
    if (contexts[0].get("name") != data.get("current-context")
            or ctx.get("namespace", NS) != NS or endpoint.scheme != "https"
            or endpoint.hostname not in ("127.0.0.1", "localhost", "::1")
            or not endpoint.port or cluster.get("insecure-skip-tls-verify")):
        raise RuntimeError("NOT_LOCAL_DEMO_ENDPOINT")
    # Independently require the live kind control plane at the SAME address.
    p = subprocess.run(
        ["kind", "get", "kubeconfig", "--name", "wjax-demo"],
        capture_output=True, text=True, timeout=10, check=False,
    )
    if p.returncode:
        raise RuntimeError("KIND_DEMO_NOT_FOUND")
    # kind writes YAML; kubectl can parse it from a temporary file only.
    # Instead ask kind for its kubeconfig via an isolated process and kubectl stdin.
    # Strict endpoint comparison is also performed against kubectl's kind context.
    p = subprocess.run(
        ["kubectl", "--context", "kind-wjax-demo", "config", "view",
         "--minify", "-o", "json"],
        capture_output=True, text=True, timeout=10, check=True,
    )
    kind_data = json.loads(p.stdout)
    kind_endpoint = kind_data["clusters"][0]["cluster"].get("server")
    if (kind_data.get("current-context") != "kind-wjax-demo"
            or kind_data["clusters"][0].get("name") != "kind-wjax-demo"
            or kind_endpoint != cluster.get("server")
            or kind_data["clusters"][0]["cluster"].get("certificate-authority-data")
               != cluster.get("certificate-authority-data")):
        raise RuntimeError("DEMO_ENDPOINT_OR_CA_MISMATCH")


def observe(config):
    obj = json.loads(run_kubectl(config, "get", "deployment", NAME, "-o", "json"))
    meta, spec, status = obj["metadata"], obj["spec"], obj.get("status", {})
    images = [c.get("image") for c in spec["template"]["spec"].get("containers", [])]
    if (meta.get("name") != NAME or meta.get("namespace") != NS
            or not meta.get("uid") or len(images) != 1 or images[0] != IMAGE
            or spec.get("selector", {}).get("matchLabels") != {"app": NAME}):
        raise RuntimeError("WORKLOAD_IDENTITY_OR_IMAGE_CHANGED")
    return {
        "uid": meta["uid"], "resourceVersion": meta["resourceVersion"],
        "generation": meta["generation"], "observedGeneration": status.get("observedGeneration", 0),
        "desired": spec.get("replicas", 1), "ready": status.get("readyReplicas", 0),
        "available": status.get("availableReplicas", 0),
    }


def ask_ollama():
    prompt = (
        "Return ONLY JSON with exactly the keys operation, workload, replicas, target. "
        "Allowed values: operation deploy or unknown, workload nginx or unknown, "
        "replicas integer or null, target demo or production. "
        "The observed local demo Deployment wjax-nginx has 0 desired replicas; "
        "trusted demo intent is exactly 2 replicas. Propose the smallest recovery."
    )
    req = urllib.request.Request(
        "http://127.0.0.1:11434/api/generate",
        data=json.dumps({"model": "llama3.2:latest", "prompt": prompt,
                         "stream": False, "format": "json",
                         "options": {"temperature": 0}}).encode(),
        headers={"Content-Type": "application/json"}, method="POST",
    )
    with urllib.request.urlopen(req, timeout=40) as res:
        obj = json.load(res)
    candidate = json.loads(obj["response"])
    if not isinstance(candidate, dict) or candidate != EXPECTED:
        raise RuntimeError("POLICY_DENY_UNEXPECTED_AI_PROPOSAL")
    return candidate


def verify(config, uid, deadline):
    while time.monotonic() < deadline:
        state = observe(config)
        if state["uid"] != uid:
            raise RuntimeError("UID_CHANGED_DURING_VERIFICATION")
        if (state["desired"] == state["ready"] == state["available"] == 2
                and state["generation"] == state["observedGeneration"]):
            return state
        time.sleep(2)
    raise RuntimeError("RECOVERY_NOT_READY_WITHIN_TIMEOUT")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--enable-hotl", action="store_true")
    modes = ap.add_mutually_exclusive_group(required=True)
    modes.add_argument("--once", action="store_true", help="One successful recovery, then exit")
    modes.add_argument("--always", action="store_true", help="Continue watching for new drift; fail closed on errors")
    ap.add_argument("--interval", type=int, default=5)
    ap.add_argument("--runtime-dir", required=True)
    args = ap.parse_args()
    if not args.enable_hotl or os.environ.get("AI_THINKERS_HOTL") != CONSENT:
        ap.error("HOTL disabled; require --enable-hotl and explicit AI_THINKERS_HOTL consent")
    if not 2 <= args.interval <= 60:
        ap.error("--interval must be 2..60 seconds")
    try:
        home = checked_runtime_dir(args.runtime_dir)
    except (OSError, RuntimeError) as exc:
        ap.error(str(exc))
    config = home / ".demo-kubeconfig.json"
    if not config.is_file() or config.is_symlink() or config.stat().st_mode & 0o077:
        ap.error("dedicated executor kubeconfig missing or unsafe")
    check_target(config)
    audit = home / "ai-thinkers-evidence.jsonl"
    lock = home / "ai-thinkers.lock"
    with secure_append(lock) as lockfile:
        try:
            fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            ap.error("another HOTL supervisor already holds this runtime lock")
        status = SupervisorStatus(home, "one-shot" if args.once else "always")
        status.start()
        record(audit, "HOTL_ENABLED", scope="local-kind/wjax-demo/wjax-nginx",
               mode=status.mode, session=status.session)
        seen = None
        completed = set()
        print("AI Thinkerers HOTL: watching. Ctrl-C stops future actions.", flush=True)
        try:
            while True:
                try:
                    status.check()
                    status.set("MONITORING")
                    state = observe(config)
                    key = (state["uid"], state["generation"])
                    # Require two consecutive observed 0/0 states for the SAME UID+generation.
                    if state["desired"] == 0 and state["ready"] == 0 and key not in completed:
                        if seen != key:
                            seen = key
                            print("Drift observed; awaiting stable second observation", flush=True)
                        else:
                            completed.add(key)  # No retries even after errors.
                            status.set("DRIFT_DETECTED")
                            record(audit, "DRIFT_CONFIRMED", uid=state["uid"],
                                   generation=state["generation"])
                            status.set("AI_ANALYZING")
                            candidate = ask_ollama()
                            record(audit, "AI_PROPOSAL", candidate=candidate,
                                   model="llama3.2:latest")
                            # Re-read immediately before mutation; reject any concurrent change.
                            fresh = observe(config)
                            if (fresh["uid"] != state["uid"] or fresh["generation"] != state["generation"]
                                    or fresh["desired"] != 0 or fresh["ready"] != 0):
                                raise RuntimeError("STALE_OBSERVATION")
                            # Atomic test/replace; no create, apply or manifest modifications.
                            patch = [
                                {"op": "test", "path": "/metadata/uid", "value": fresh["uid"]},
                                {"op": "test", "path": "/metadata/resourceVersion",
                                 "value": fresh["resourceVersion"]},
                                {"op": "test", "path": "/spec/replicas", "value": 0},
                                {"op": "replace", "path": "/spec/replicas", "value": 2},
                            ]
                            # Revalidate the pinned local kind target immediately before a write.
                            check_target(config)
                            status.set("EXECUTING")
                            run_kubectl(config, "patch", "deployment", NAME, "--type=json",
                                        "-p", json.dumps(patch))
                            record(audit, "HOTL_EXECUTED", uid=fresh["uid"],
                                   generation=fresh["generation"], action="replicas:0->2")
                            status.set("VERIFYING")
                            recovered = verify(config, fresh["uid"], time.monotonic() + 90)
                            record(audit, "HOTL_RECOVERY_VERIFIED", uid=fresh["uid"],
                                   result="READY_VERIFIED", observed=recovered)
                            if args.once:
                                status.stop("STOPPED")
                                return 0
                            status.set("MONITORING")
                    else:
                        seen = None
                except Exception as exc:
                    status.stop("FAILED_CLOSED")
                    record(audit, "HOTL_FAILED_CLOSED", reason=str(exc)[:140])
                    return 1  # No blind retry after errors.
                time.sleep(args.interval)
        except KeyboardInterrupt:
            status.stop("STOPPED")
            record(audit, "HOTL_STOPPED_BY_OPERATOR")
            return 0


if __name__ == "__main__":
    sys.exit(main())
