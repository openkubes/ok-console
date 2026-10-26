#!/usr/bin/env python3
"""W-JAX lab only: append terminal observation after an approved demo apply.

No Kubernetes writes. No authorization or executor changes. Does not turn a
separate CLI verification into proof of automated orchestration.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

NAME = 'wjax-nginx'
NS = 'wjax-demo'
IMAGE = 'nginx:1.27.5-alpine'

def events_from(path):
    result = []
    with path.open(encoding='utf-8') as f:
        for line in f:
            if line.strip():
                obj = json.loads(line)
                if isinstance(obj, dict):
                    result.append(obj)
    return result

def fetch(config):
    p = subprocess.run(['kubectl', '--kubeconfig', str(config), '-n', NS,
                        'get', 'deployment', NAME, '-o', 'json'],
                       text=True, capture_output=True, timeout=12, check=False)
    if p.returncode:
        raise RuntimeError('Kubernetes deployment observation failed (no credential details printed)')
    return json.loads(p.stdout)

def state(obj):
    meta, spec, status = obj['metadata'], obj['spec'], obj.get('status', {})
    containers = spec.get('template', {}).get('spec', {}).get('containers', [])
    images = [c.get('image') for c in containers]
    return {'uid': meta.get('uid'), 'generation': meta.get('generation'),
            'observedGeneration': status.get('observedGeneration', 0),
            'desired': spec.get('replicas', 1), 'ready': status.get('readyReplicas', 0),
            'available': status.get('availableReplicas', 0), 'images': images}

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--demo-dir', required=True)
    p.add_argument('--timeout', type=int, default=90)
    args = p.parse_args()
    if not 1 <= args.timeout <= 180:
        p.error('--timeout must be 1..180')
    home = Path(args.demo_dir).expanduser().resolve()
    audit = home / 'evidence.jsonl'
    kubeconfig = home / '.demo-kubeconfig.json'
    if not audit.is_file() or not kubeconfig.is_file():
        sys.exit('Missing demo audit or dedicated executor kubeconfig')
    es = events_from(audit)
    applies = [(i, e) for i, e in enumerate(es) if e.get('event') == 'EXECUTOR_APPLIED']
    if not applies:
        sys.exit('No executor apply event; refusing to verify')
    idx, applied = applies[-1]
    dg = applied.get('digest')
    if not isinstance(dg, str) or len(dg) != 64 or any(c not in '0123456789abcdef' for c in dg):
        sys.exit('Invalid operation digest')
    approvals = [e for e in es[:idx] if e.get('event') == 'HUMAN_APPROVED' and e.get('digest') == dg]
    if not approvals:
        sys.exit('No prior matching HUMAN_APPROVED event; refusing to verify')
    terminal_events = [
        e for e in es[idx + 1:]
        if e.get('digest') == dg
        and e.get('event') in ('RECOVERY_VERIFIED', 'RECOVERY_VERIFICATION_FAILED')
    ]
    if terminal_events:
        last_terminal = terminal_events[-1]
        if (last_terminal.get('event') == 'RECOVERY_VERIFIED'
                and last_terminal.get('result') == 'READY_VERIFIED'):
            print('ALREADY_VERIFIED: recovery evidence exists; no duplicate written')
            return 0
        sys.exit('A previous recovery verification failed; refusing to overwrite terminal evidence')
    before = applied.get('observed') or {}
    original_uid = before.get('uid')
    applied_generation = before.get('generation')
    if not original_uid or not isinstance(applied_generation, int):
        sys.exit('Apply event lacks UID/generation: unable to correlate observation')
    if applied.get('result') not in ('APPLY_SUBMITTED_NOT_READY', 'READY_VERIFIED', 'READY_VERIFIED_EXISTING'):
        sys.exit('Apply event has unexpected result; refusing verification')
    deadline = time.monotonic() + args.timeout
    observed = None
    while True:
        observed = state(fetch(kubeconfig))
        good = (observed['uid'] == original_uid and observed['generation'] >= applied_generation
                and observed['generation'] == observed['observedGeneration']
                and observed['desired'] == 2 and observed['ready'] == 2 and observed['available'] == 2
                and IMAGE in observed['images'])
        if good or time.monotonic() >= deadline:
            break
        time.sleep(2)
    record = {
        'at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'event': 'RECOVERY_VERIFIED' if good else 'RECOVERY_VERIFICATION_FAILED',
        'digest': dg,
        'result': 'READY_VERIFIED' if good else 'NOT_READY_WITHIN_TIMEOUT',
        'source': 'POST_EXECUTION_READ_ONLY_KUBECTL',
        'uid': observed['uid'], 'generation': observed['generation'],
        'observedGeneration': observed['observedGeneration'],
        'desired': observed['desired'], 'ready': observed['ready'],
        'available': observed['available'], 'image_match': IMAGE in observed['images'],
    }
    # Local demo audit, append-only convention; no cryptographic integrity guarantee.
    with audit.open('a', encoding='utf-8') as f:
        f.write(json.dumps(record, sort_keys=True) + '\n')
        f.flush()
        os.fsync(f.fileno())
    print(json.dumps(record, indent=2))
    return 0 if good else 1

if __name__ == '__main__':
    sys.exit(main())
