#!/usr/bin/env python3
"""Safely rotate both local W-JAX demo identities; never change RBAC/workloads."""
import json
import os
import stat
import sys
import tempfile
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEMO = ROOT / 'demos' / 'wjax-2026'
sys.path.insert(0, str(DEMO))
import setup_identity

CONTEXT = 'kind-wjax-demo'
NAMESPACE = 'wjax-demo'


def kube(*args):
    p = subprocess.run(['kubectl', *args], capture_output=True, text=True, timeout=25)
    if p.returncode != 0:
        raise RuntimeError('kubectl operation failed (output withheld to protect credentials)')
    return p.stdout.strip()


def check_file(path, identity, cluster):
    if path.is_symlink() or not path.is_file():
        raise ValueError(f'{identity}: credential must be an existing regular file, not a symlink')
    st = path.stat(follow_symlinks=False)
    if st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink != 1:
        raise ValueError(f'{identity}: credential must be owned by current user, mode 0600, single link')
    if path.parent.is_symlink():
        raise ValueError('Refusing symlinked credential directory')
    dr = path.parent.stat(follow_symlinks=False)
    if dr.st_uid != os.geteuid() or stat.S_IMODE(dr.st_mode) != 0o700:
        raise ValueError('Credential directory must be user-owned and mode 0700')
    # kubectl parses both YAML and JSON kubeconfig formats. Never log raw
    # output: --raw includes the current service-account token.
    p = subprocess.run(
        ['kubectl', '--kubeconfig', str(path), 'config', 'view',
         '--raw', '--minify', '--flatten', '-o', 'json'],
        capture_output=True, text=True, timeout=25,
    )
    if p.returncode != 0:
        raise RuntimeError(f'{identity}: kubeconfig cannot be parsed')
    cfg = json.loads(p.stdout)

    sa = 'wjax-console-reader' if identity == 'reader' else 'wjax-demo-executor'
    if cfg.get('current-context') != CONTEXT:
        raise ValueError(f'{identity}: unexpected context')
    contexts = cfg.get('contexts', [])
    clusters = cfg.get('clusters', [])
    users = cfg.get('users', [])
    if (len(contexts) != 1 or contexts[0]['name'] != CONTEXT
            or contexts[0]['context'] != {'cluster': CONTEXT, 'user': sa, 'namespace': NAMESPACE}
            or len(clusters) != 1 or clusters[0]['name'] != CONTEXT
            or clusters[0]['cluster'] != {'server': cluster['server'], 'certificate-authority-data': cluster['certificate-authority-data']}
            or len(users) != 1 or users[0]['name'] != sa or not isinstance(users[0].get('user', {}).get('token'), str)):
        raise ValueError(f'{identity}: unexpected identity or trust configuration')
    return cfg, sa


def write_private(path, cfg):
    fd, temp = tempfile.mkstemp(prefix='.wjax-auth-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump(cfg, out, indent=2)
            out.flush()
            os.fsync(out.fileno())
        return Path(temp)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def rotate():
    if os.environ.get('WJAX_KUBE_CONTEXT', CONTEXT) != CONTEXT:
        raise ValueError('Only kind-wjax-demo is permitted')
    duration = setup_identity.token_duration()
    # Verify authoritative kind CA, API and namespace before issuing any token.
    cluster = setup_identity.validate_cluster(CONTEXT)
    runtime = Path(os.environ.get('WJAX_DEMO_RUNTIME_DIR', ROOT / '.wjax-local-runtime')).expanduser().absolute()
    reader = Path(os.environ.get('WJAX_READER_KUBECONFIG', runtime / 'wjax-reader.kubeconfig')).expanduser().absolute()
    executor = runtime / '.demo-kubeconfig.json'
    if reader.parent != runtime or executor.parent != runtime:
        raise ValueError('Credentials must be in the expected private runtime directory')
    specs = [('reader', reader), ('executor', executor)]
    prepared = []
    originals = {}
    installed = []
    try:
        # Validate both old files BEFORE any rotation.
        for identity, path in specs:
            cfg, sa = check_file(path, identity, cluster)
            originals[path] = path.read_bytes()
            prepared.append([identity, path, cfg, sa, None])
        # Create and RBAC-check both new configurations, without changing active files.
        for item in prepared:
            identity, path, cfg, sa, _ = item
            token = kube('--context', CONTEXT, '-n', NAMESPACE, 'create', 'token', sa, '--duration=' + duration)
            if not token:
                raise RuntimeError('TokenRequest returned an empty token')
            cfg['users'][0]['user']['token'] = token
            staged = write_private(path, cfg)
            item[4] = staged
            setup_identity.check_permissions(staged, identity)
        # Both passed independent least-privilege checks; atomically replace each.
        for identity, path, cfg, sa, staged in prepared:
            os.replace(staged, path)
            installed.append(path)
        print(f'Reader + executor credentials rotated and RBAC verified (requested duration: {duration}).')
        print('No Kubernetes RBAC, workloads, namespaces, or cluster resources modified.')
        return 0
    except BaseException:
        # Restore originals if replacement partially succeeded.
        for path in reversed(installed):
            rescue = None
            try:
                fd, tmp = tempfile.mkstemp(prefix='.wjax-rollback-', dir=path.parent)
                rescue = Path(tmp)
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, 'wb') as out:
                    out.write(originals[path])
                    out.flush()
                    os.fsync(out.fileno())
                os.replace(rescue, path)
            finally:
                if rescue is not None:
                    rescue.unlink(missing_ok=True)
        raise
    finally:
        for item in prepared:
            if item[4] is not None:
                item[4].unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        sys.exit(rotate())
    except Exception:
        print('Credential rotation failed; inspect cluster, paths and RBAC. No tokens printed.', file=sys.stderr)
        sys.exit(1)
