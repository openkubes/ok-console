#!/usr/bin/env python3
"""W-JAX-only, loopback read-only view adapter; not the Console BFF."""
import json
import os
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = '127.0.0.1'
PORT = 8791
CONFIG = os.environ.get('WJAX_READONLY_KUBECONFIG', '')
NAMESPACE = 'wjax-demo'


def query(kind):
    if not CONFIG:
        raise RuntimeError('WJAX_READONLY_KUBECONFIG is required')
    result = subprocess.run(
        ['kubectl', '--kubeconfig', CONFIG, '--namespace', NAMESPACE,
         'get', kind, '-o', 'json'],
        capture_output=True, text=True, timeout=6, check=False,
    )
    if result.returncode:
        raise RuntimeError('READ_ONLY_QUERY_FAILED')
    return json.loads(result.stdout).get('items', [])


def projection():
    deployments = []
    for item in query('deployments'):
        metadata, spec, status = item['metadata'], item['spec'], item.get('status', {})
        deployments.append({
            'name': metadata['name'], 'uid': metadata.get('uid'),
            'desired': spec.get('replicas', 1), 'ready': status.get('readyReplicas', 0),
            'generation': metadata.get('generation'),
            'observedGeneration': status.get('observedGeneration'),
        })
    pods = []
    for item in query('pods'):
        metadata, status = item['metadata'], item.get('status', {})
        pods.append({
            'name': metadata['name'], 'phase': status.get('phase', 'Unknown'),
            'ready': bool(status.get('containerStatuses')) and all(
                x.get('ready', False) for x in status.get('containerStatuses', [])
            ),
            'restarts': sum(x.get('restartCount', 0) for x in status.get('containerStatuses', [])),
        })
    return {'cluster': 'kind-wjax-demo', 'namespace': NAMESPACE,
            'deployments': deployments, 'pods': pods, 'mode': 'read-only-live'}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/api/wjax-kind/snapshot':
            return self.respond(404, {'error': 'NOT_FOUND'})
        try:
            return self.respond(200, projection())
        except Exception:
            return self.respond(503, {'error': 'OBSERVATION_UNAVAILABLE'})

    def do_POST(self):
        return self.respond(405, {'error': 'READ_ONLY'})

    do_PUT = do_POST
    do_PATCH = do_POST
    do_DELETE = do_POST

    def respond(self, status, obj):
        raw = json.dumps(obj).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *_args):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
