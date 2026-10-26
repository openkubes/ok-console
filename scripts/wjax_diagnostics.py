#!/usr/bin/env python3
"""Local W-JAX deterministic ADR-021 investigation against loopback reader.
No Kubernetes credentials, no LLM, no remediation capability.
"""
import json
import os
import re
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = '127.0.0.1'
PORT = int(os.environ.get('WJAX_DIAGNOSTICS_PORT', '8793'))
READER_URL = 'http://127.0.0.1:8791/api/wjax-kind/snapshot'
SUBJECT = ('kind-wjax-demo', 'wjax-demo', 'wjax-nginx')
CAPS = {'workload_events': False, 'workload_logs': False,
        'cilium_diagnostics': False, 'host_journal': False, 'node_shell': False}


def utcnow():
    return datetime.now(timezone.utc)


def timestamp(dt):
    return dt.isoformat().replace('+00:00', 'Z')


def investigate(body):
    if not isinstance(body, dict) or set(body) - {'cluster', 'namespace', 'workload', 'time_range'}:
        raise ValueError('invalid request properties')
    if tuple(body.get(k) for k in ('cluster', 'namespace', 'workload')) != SUBJECT:
        raise ValueError('only the local W-JAX demo workload is supported')
    duration = body.get('time_range', 'PT1H')
    match = re.fullmatch(r'PT(?:(\d+)H)?(?:(\d+)M)?', duration) if isinstance(duration, str) else None
    if not match or (not match.group(1) and not match.group(2)):
        raise ValueError('time_range must be a positive PT#H#M duration')
    delta = timedelta(hours=int(match.group(1) or 0), minutes=int(match.group(2) or 0))
    if not timedelta(0) < delta <= timedelta(days=7):
        raise ValueError('time_range outside supported window')
    request = urllib.request.Request(READER_URL, headers={'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=5) as response:
        snapshot = json.load(response)
    if snapshot.get('cluster') != SUBJECT[0] or snapshot.get('namespace') != SUBJECT[1] or snapshot.get('mode') != 'read-only-live':
        raise RuntimeError('unexpected reader source')
    deployments = [d for d in snapshot.get('deployments', []) if d.get('name') == SUBJECT[2]]
    if len(deployments) != 1:
        raise RuntimeError('target workload not found or ambiguous')
    deployment = deployments[0]
    # Reader snapshots do not expose owner references. Do not assume unrelated pods belong to the workload.
    pods = [p for p in snapshot.get('pods', []) if p.get('name', '').startswith(SUBJECT[2] + '-')]
    end = utcnow()
    inv = 'inv-wjax-' + uuid.uuid4().hex
    prefix = 'k8s://kind-wjax-demo/namespaces/wjax-demo'
    evidence = [
        {'id': inv + '-deployment', 'type': 'deployment_status', 'source': 'wjax-read-only-reader',
         'status': 'available', 'uri': prefix + '/deployments/wjax-nginx', 'collected_at': timestamp(end)},
        {'id': inv + '-pods', 'type': 'pod_status', 'source': 'wjax-read-only-reader',
         'status': 'available', 'uri': prefix + '/pods?selector=wjax-nginx', 'collected_at': timestamp(end)},
        {'id': inv + '-events', 'type': 'events', 'source': 'wjax-read-only-reader',
         'status': 'unavailable', 'reason': 'Reader RBAC does not allow listing Kubernetes events',
         'collected_at': timestamp(end)},
    ]
    desired = int(deployment.get('desired', 0))
    ready = int(deployment.get('ready', 0))
    observed = deployment.get('observedGeneration')
    generation = deployment.get('generation')
    ready_pods = sum(p.get('ready') is True and p.get('phase') == 'Running' for p in pods)
    healthy = desired == ready and ready_pods >= desired and generation == observed and desired > 0
    symptoms = [] if healthy else [
        f'Deployment ready replicas {ready}/{desired}; observed ready pods {ready_pods}; generation {observed}/{generation}'
    ]
    return {
        'invocation_id': inv, 'cluster': SUBJECT[0], 'namespace': SUBJECT[1], 'workload': SUBJECT[2],
        'generated_at': timestamp(end),
        'effective_time_range': {'start': timestamp(end - delta), 'end': timestamp(end)},
        'summary': ('Workload currently healthy according to live read-only deployment/pod observation.'
                    if healthy else 'Workload shows a readiness or reconciliation discrepancy; cause not established.'),
        'symptoms': symptoms, 'evidence': evidence,
        'probable_causes': [],  # No fabricated causal hypothesis from snapshot alone.
        'recommended_next_steps': ([] if healthy else [
            'Have an operator inspect the workload and obtain events through an explicitly authorized diagnostics provider.'
        ]),
        'references': [], 'provider_capabilities': CAPS,
    }


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != '/v1/investigate_workload':
            return self.respond(404, {'code': 'not_found'})
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 4096:
                raise ValueError('invalid content length')
            body = json.loads(self.rfile.read(size))
            result = investigate(body)
            self.respond(200, result)
        except (ValueError, json.JSONDecodeError) as error:
            self.respond(422, {'code': 'invalid_request', 'message': str(error)})
        except (OSError, RuntimeError, urllib.error.URLError, TimeoutError):
            self.respond(503, {'code': 'provider_unavailable', 'message': 'Live reader observation unavailable'})

    def do_GET(self):
        self.respond(405, {'code': 'method_not_allowed'})
    do_PUT = do_GET
    do_PATCH = do_GET
    do_DELETE = do_GET

    def respond(self, code, value):
        raw = json.dumps(value).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_args):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
