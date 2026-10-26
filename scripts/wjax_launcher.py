#!/usr/bin/env python3
"""Disposable LOCAL W-JAX demo launcher; no cluster mutations or production BFF changes."""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(os.environ.get('WJAX_CONSOLE_DIR', Path(__file__).resolve().parents[1])).resolve()
STATE = ROOT / '.wjax-local-processes.json'
LOG_DIR = ROOT / '.wjax-local-logs'
DEMO = Path(os.environ.get('WJAX_DEMO_DIR', ROOT.parent / 'openkubes-wjax-local-demo')).expanduser().resolve()
READER = Path(os.environ.get('WJAX_READER_DIR', ROOT.parent / 'wjax-console-kind')).expanduser().resolve()
READER_CONFIG = Path(os.environ.get('WJAX_READER_KUBECONFIG', READER / 'wjax-reader.kubeconfig')).expanduser().resolve()
PORTS = {'console': 8790, 'demo': 8788, 'reader': 8791, 'diagnostics': 8793}
EXECUTOR_CONFIG = DEMO / '.demo-kubeconfig.json'
KUBE_CONTEXT = (os.environ.get('WJAX_KUBE_CONTEXT') or 'kind-wjax-demo')
NAMESPACE = 'wjax-demo'
WORKLOAD = 'wjax-nginx'
EXECUTOR_SA = 'wjax-demo-executor'


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

def listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.35):
            return True
    except OSError:
        return False

def endpoint(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return r.status == 200
    except Exception:
        return False

DIAGNOSTICS_URL = 'http://127.0.0.1:8793/v1/investigate_workload'
DIAGNOSTICS_BODY = {'cluster': 'kind-wjax-demo', 'namespace': 'wjax-demo', 'workload': 'wjax-nginx', 'time_range': 'PT1H'}


def diagnostics_probe(check_negative=False):
    """Run a real read-only ADR-021 request, not a nonexistent GET healthcheck."""
    def post(body):
        request = urllib.request.Request(DIAGNOSTICS_URL, data=json.dumps(body).encode(),
                                         headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=7) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as err:
            return err.code, json.load(err)
    try:
        code, payload = post(DIAGNOSTICS_BODY)
        if code != 200 or any(payload.get(k) != v for k, v in DIAGNOSTICS_BODY.items() if k != 'time_range'):
            return False
        if not payload.get('invocation_id') or not isinstance(payload.get('evidence'), list):
            return False
        if not check_negative:
            return True
        forbidden = dict(DIAGNOSTICS_BODY, workload='other-workload')
        negative_status, _ = post(forbidden)
        return negative_status == 422
    except (OSError, ValueError, KeyError, TimeoutError):
        return False


def owned_pid(pid, marker):
    if not alive(pid):
        return False
    try:
        proc = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True, timeout=2)
        return proc.returncode == 0 and marker in proc.stdout
    except Exception:
        return False

def run_command(args, timeout=12):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)

def executor_check():
    """Verify actual execution credentials and named workload RBAC; never mutate cluster."""
    if not EXECUTOR_CONFIG.is_file():
        print(f'Executor kubeconfig missing: {EXECUTOR_CONFIG}')
        return False
    prefix = ['kubectl', '--kubeconfig', str(EXECUTOR_CONFIG)]
    observations = [
        ('read deployment', ['get', 'deployment', WORKLOAD, '-n', NAMESPACE, '-o', 'name'], True),
        ('get named deployment', ['auth', 'can-i', 'get', 'deployments.apps/' + WORKLOAD, '-n', NAMESPACE], True),
        ('patch named deployment', ['auth', 'can-i', 'patch', 'deployments.apps/' + WORKLOAD, '-n', NAMESPACE], True),
        ('update named deployment', ['auth', 'can-i', 'update', 'deployments.apps/' + WORKLOAD, '-n', NAMESPACE], True),
        ('create deployments in demo namespace', ['auth', 'can-i', 'create', 'deployments.apps', '-n', NAMESPACE], True),
        ('delete named deployment denied', ['auth', 'can-i', 'delete', 'deployments.apps/' + WORKLOAD, '-n', NAMESPACE], False),
        ('delete namespaces denied', ['auth', 'can-i', 'delete', 'namespaces'], False),
        ('patch other deployment denied', ['auth', 'can-i', 'patch', 'deployments.apps/not-wjax-nginx', '-n', NAMESPACE], False),
    ]
    failures = []
    for label, args, expected in observations:
        try:
            result = run_command(prefix + args)
        except (OSError, subprocess.TimeoutExpired) as error:
            failures.append(f'{label}: {error}')
            continue
        if args[0] == 'get':
            actual = result.returncode == 0 and result.stdout.strip() == 'deployment.apps/' + WORKLOAD
        else:
            # kubectl auth can-i may return exit code 0 for "no"; inspect response.
            actual = result.returncode == 0 and result.stdout.strip() == 'yes'
        if actual != expected or (not expected and result.returncode not in (0, 1)):
            failures.append(f'{label}: expected {"yes" if expected else "no"}, got {result.stdout.strip() or result.stderr.strip() or "command failed"}')
        else:
            print(f'  {label}: PASS')
    if failures:
        print('Executor check FAILED:')
        for item in failures:
            print(' -', item)
        return False
    print('Executor authentication and bounded RBAC: PASS')
    return True

def refresh_executor_auth():
    """Explicit token rotation only. No role, workload or context changes."""
    if not EXECUTOR_CONFIG.is_file():
        print(f'Executor kubeconfig missing: {EXECUTOR_CONFIG}', file=sys.stderr)
        return 1
    # Ensure issuer context is available before requesting a token.
    try:
        issuer = run_command(['kubectl', '--context', KUBE_CONTEXT, '-n', NAMESPACE,
                              'create', 'token', EXECUTOR_SA, '--duration=8h'])
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f'Unable to request ServiceAccount token: {error}', file=sys.stderr)
        return 1
    if issuer.returncode != 0 or not issuer.stdout.strip():
        print(f'Token request failed: {issuer.stderr.strip()}', file=sys.stderr)
        return 1
    token = issuer.stdout.strip()
    # Read the active context's user, not a hard-coded credential name.
    context = run_command(['kubectl', '--kubeconfig', str(EXECUTOR_CONFIG), 'config', 'current-context'])
    if context.returncode != 0:
        print('Executor kubeconfig has no active context', file=sys.stderr)
        return 1
    user = run_command(['kubectl', '--kubeconfig', str(EXECUTOR_CONFIG), 'config', 'view',
                        '--minify', '-o', 'jsonpath={.contexts[0].context.user}'])
    name = user.stdout.strip()
    if user.returncode != 0 or not name:
        print('Unable to resolve active executor credential name', file=sys.stderr)
        return 1
    # Prevent accidentally rotating a credential in an unrelated kubeconfig.
    if EXECUTOR_CONFIG.is_symlink():
        print('Refusing to update symlinked executor kubeconfig', file=sys.stderr)
        return 1
    os.chmod(EXECUTOR_CONFIG, 0o600)
    result = run_command(['kubectl', '--kubeconfig', str(EXECUTOR_CONFIG),
                          'config', 'set-credentials', name, '--token=' + token])
    token = None
    if result.returncode != 0:
        print(f'Credential update failed: {result.stderr.strip()}', file=sys.stderr)
        return 1
    os.chmod(EXECUTOR_CONFIG, 0o600)
    print(f'Refreshed local executor credential {name} (requested duration: 8h).')
    print('No Kubernetes RBAC or workloads modified.')
    return 0 if executor_check() else 1

def preflight():
    problems = []
    for name, path in [('Console package.json', ROOT / 'package.json'), ('Vite config', ROOT / 'vite.config.ts'), ('Demo server', DEMO / 'demo.py'), ('Reader server', READER / 'kind_reader.py'), ('Reader kubeconfig', READER_CONFIG), ('Diagnostics server', ROOT / 'scripts' / 'wjax_diagnostics.py')]:
        if not path.is_file():
            problems.append(f'{name} missing: {path}')
    for name, binary in [('pnpm', 'pnpm'), ('kubectl', 'kubectl')]:
        if not shutil.which(binary):
            problems.append(f'{name} is not installed or not in PATH')
    if (DEMO / 'demo.py').is_file():
        source = (DEMO / 'demo.py').read_text()
        if '8788' not in source:
            problems.append('Expected demo.py to bind port 8788; confirm demo server version')
    if (ROOT / 'vite.config.ts').is_file() and '/api/wjax-kind' not in (ROOT / 'vite.config.ts').read_text():
        problems.append('Vite proxy /api/wjax-kind missing from vite.config.ts')
    if not endpoint('http://127.0.0.1:11434/api/tags'):
        problems.append('Ollama not reachable at 127.0.0.1:11434 (start ollama serve)')
    if not STATE.exists():
        for name, port in PORTS.items():
            if listening(port):
                problems.append(f'{port} already occupied ({name}); stop the existing process explicitly first')
    if problems:
        print('Preflight failed:')
        for problem in problems:
            print(' -', problem)
        return False
    if not executor_check():
        return False
    print('Preflight OK: local inputs and executor credentials/RBAC verified')
    return True

def load():
    if not STATE.exists():
        return {}
    try:
        return json.loads(STATE.read_text())
    except Exception:
        return {}

def status():
    data = load()
    for name, port in PORTS.items():
        entry = data.get(name, {})
        pid = entry.get('pid')
        own = bool(pid and owned_pid(pid, entry.get('marker', '___never___')))
        url = {'console': 'http://127.0.0.1:8790/wjax-kind.html', 'demo': 'http://127.0.0.1:8788/api/status', 'reader': 'http://127.0.0.1:8791/api/wjax-kind/snapshot', 'diagnostics': DIAGNOSTICS_URL}[name]
        print(f'{name:8} port={port} owned={own} process={"running" if own else "not owned"} http={"OK" if (diagnostics_probe() if name == 'diagnostics' else endpoint(url)) else "UNAVAILABLE"}')

def stop():
    data = load()
    if not data:
        print('No launcher-owned processes recorded.')
        return
    for name in ('console', 'demo', 'diagnostics', 'reader'):
        entry = data.get(name, {})
        pid = entry.get('pid')
        if not pid or not owned_pid(pid, entry.get('marker', '___never___')):
            print(f'{name}: not terminating (PID absent or ownership cannot be verified)')
            continue
        try:
            os.killpg(pid, signal.SIGTERM)
            print(f'{name}: sent SIGTERM to launcher-owned process group {pid}')
        except ProcessLookupError:
            pass
    STATE.unlink(missing_ok=True)

def start():
    if STATE.exists():
        print('A launcher state file already exists. Run make wjax-demo-status, then make wjax-demo-stop before restarting.')
        return 1
    if not preflight():
        return 1
    LOG_DIR.mkdir(exist_ok=True)
    definitions = [
        ('reader', [sys.executable, str(READER / 'kind_reader.py')], READER, {**os.environ, 'WJAX_READONLY_KUBECONFIG': str(READER_CONFIG)}, 'kind_reader.py'),
        ('diagnostics', [sys.executable, str(ROOT / 'scripts' / 'wjax_diagnostics.py')], ROOT, os.environ.copy(), 'wjax_diagnostics.py'),
        ('demo', [sys.executable, str(DEMO / 'demo.py')], DEMO, {**os.environ, 'AI_MODE': 'ollama', 'OLLAMA_MODEL': os.getenv('WJAX_AI_MODEL', 'llama3.2:latest')}, 'demo.py'),
        ('console', ['pnpm', 'dev', '--host', '127.0.0.1', '--port', '8790', '--strictPort'], ROOT, os.environ.copy(), 'pnpm'),
    ]
    entries = {}
    try:
        for name, command, cwd, env, marker in definitions:
            stream = (LOG_DIR / f'{name}.log').open('ab')
            try:
                process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            finally:
                stream.close()
            entries[name] = {'pid': process.pid, 'marker': marker}
            STATE.write_text(json.dumps(entries, indent=2))
        urls = {'reader':'http://127.0.0.1:8791/api/wjax-kind/snapshot','demo':'http://127.0.0.1:8788/api/status','console':'http://127.0.0.1:8790/wjax-kind.html', 'diagnostics':DIAGNOSTICS_URL}
        for name, url in urls.items():
            for _ in range(30):
                if (diagnostics_probe() if name == 'diagnostics' else endpoint(url)):
                    break
                time.sleep(0.3)
            else:
                raise RuntimeError(f'{name} failed HTTP check; inspect {LOG_DIR / (name + ".log")}')
        print('W-JAX local stack started:')
        print(' Console: http://127.0.0.1:8790/#/clusters')
        print(' Live kind: http://127.0.0.1:8790/wjax-kind.html')
        print(' Agentic:  http://127.0.0.1:8788/')
        print(' Diagnostics: http://127.0.0.1:8793/v1/investigate_workload')
        print(' Logs:', LOG_DIR)
        return 0
    except Exception as error:
        print('Launch failed:', error)
        stop()
        return 1

if __name__ == '__main__':
    action = sys.argv[1] if len(sys.argv) > 1 else 'status'
    if action == 'check':
        sys.exit(0 if preflight() else 1)
    elif action == 'start':
        sys.exit(start())
    elif action == 'stop':
        stop()
    elif action == 'status':
        status()
    elif action == 'diagnose':
        success = diagnostics_probe(check_negative=True)
        print('ADR-021 local diagnostics (healthy subject + foreign workload rejection):', 'PASS' if success else 'FAIL')
        sys.exit(0 if success else 1)
    elif action == 'auth':
        sys.exit(refresh_executor_auth())
    else:
        raise SystemExit('Use: start | check | status | stop | auth | diagnose')
