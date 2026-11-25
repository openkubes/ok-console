#!/usr/bin/env python3
"""AI Thinkers HOTL local-kind spike. NOT production automation.

Explicit enablement; exact workload guard; AI only proposes; atomic Kubernetes
preconditions; separate evidence; Ctrl-C stops future attempts.
"""
import argparse
import fcntl
import json
import os
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


def record(path, event, **kwargs):
    item = {"at": datetime.now(timezone.utc).isoformat(), "event": event, **kwargs}
    with path.open("a", encoding="utf-8") as f:
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
    if (ctx.get("namespace", NS) != NS or endpoint.scheme != "https"
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
    if kind_endpoint != cluster.get("server"):
        raise RuntimeError("DEMO_ENDPOINT_MISMATCH")


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
    ap.add_argument("--once", action="store_true", help="One recovery maximum, then exit")
    ap.add_argument("--interval", type=int, default=5)
    ap.add_argument("--runtime-dir", required=True)
    args = ap.parse_args()
    if not args.enable_hotl or os.environ.get("AI_THINKERS_HOTL") != CONSENT:
        ap.error("HOTL disabled; require --enable-hotl and explicit AI_THINKERS_HOTL consent")
    if not 2 <= args.interval <= 60:
        ap.error("--interval must be 2..60 seconds")
    home = Path(args.runtime_dir).expanduser().resolve(strict=True)
    if home.is_symlink() or home.stat().st_mode & 0o077:
        ap.error("runtime directory must be private (0700)")
    config = home / ".demo-kubeconfig.json"
    if not config.is_file() or config.is_symlink() or config.stat().st_mode & 0o077:
        ap.error("dedicated executor kubeconfig missing or unsafe")
    check_target(config)
    audit = home / "ai-thinkers-evidence.jsonl"
    lock = home / "ai-thinkers.lock"
    with lock.open("a+") as lockfile:
        try:
            fcntl.flock(lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            ap.error("another HOTL supervisor already holds this runtime lock")
        record(audit, "HOTL_ENABLED", scope="local-kind/wjax-demo/wjax-nginx",
               mode="one-shot" if args.once else "watch")
        seen = None
        completed = set()
        print("AI Thinkers HOTL: watching. Ctrl-C stops future actions.", flush=True)
        try:
            while True:
                try:
                    state = observe(config)
                    key = (state["uid"], state["generation"])
                    # Require two consecutive observed 0/0 states for the SAME UID+generation.
                    if state["desired"] == 0 and state["ready"] == 0 and key not in completed:
                        if seen != key:
                            seen = key
                            print("Drift observed; awaiting stable second observation", flush=True)
                        else:
                            completed.add(key)  # No retries even after errors.
                            record(audit, "DRIFT_CONFIRMED", uid=state["uid"],
                                   generation=state["generation"])
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
                            run_kubectl(config, "patch", "deployment", NAME, "--type=json",
                                        "-p", json.dumps(patch))
                            record(audit, "HOTL_EXECUTED", uid=fresh["uid"],
                                   generation=fresh["generation"], action="replicas:0->2")
                            recovered = verify(config, fresh["uid"], time.monotonic() + 90)
                            record(audit, "HOTL_RECOVERY_VERIFIED", uid=fresh["uid"],
                                   result="READY_VERIFIED", observed=recovered)
                            if args.once:
                                return 0
                    else:
                        seen = None
                except Exception as exc:
                    record(audit, "HOTL_FAILED_CLOSED", reason=str(exc)[:140])
                    return 1  # No blind retry after errors.
                time.sleep(args.interval)
        except KeyboardInterrupt:
            record(audit, "HOTL_STOPPED_BY_OPERATOR")
            return 0


if __name__ == "__main__":
    sys.exit(main())
