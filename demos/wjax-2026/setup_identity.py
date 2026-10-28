"""Provision ONE demo identity. Never create/reset the cluster or workload."""
import json
import stat
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CONTEXT = 'kind-wjax-demo'
NS = 'wjax-demo'


def run(args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, timeout=20, **kwargs)
    if result.returncode:
        # Never print raw stderr: kubectl errors may include credential material.
        raise RuntimeError('Command failed: ' + ' '.join(args[:3]))
    return result.stdout.strip()


def validate_cluster(context=CONTEXT):
    if context != CONTEXT:
        raise ValueError('Only the exact kind-wjax-demo context is permitted')
    if 'wjax-demo' not in run(['kind', 'get', 'clusters']).splitlines():
        raise ValueError('kind cluster wjax-demo not found')
    cfg = json.loads(run(['kubectl', '--context', CONTEXT, 'config', 'view',
                          '--raw', '--minify', '--flatten', '-o', 'json']))
    # Ask kind itself for this cluster's kubeconfig, independent of KUBECONFIG.
    # Convert via stdin without persisting kind's administrator credentials.
    supplied = run(['kind', 'get', 'kubeconfig', '--name', 'wjax-demo'])
    expected = json.loads(run(['kubectl', '--kubeconfig=/dev/stdin', '--context', CONTEXT,
                               'config', 'view', '--raw', '--minify', '--flatten',
                               '-o', 'json'], input=supplied))
    cluster = cluster_info(cfg)
    authoritative = cluster_info(expected)
    if any(cluster[key] != authoritative[key]
           for key in ('server', 'certificate-authority-data')):
        raise ValueError('Selected API/CA does not match kind cluster wjax-demo')
    result = run(['kubectl', '--context', CONTEXT, 'get', 'namespace', NS, '-o', 'name'])
    if result != 'namespace/' + NS:
        raise ValueError('Unexpected namespace observation')
    return cluster


def cluster_info(cfg):
    """Validate both selected and kind-supplied context/cluster projections."""
    if (cfg.get('current-context') != CONTEXT or len(cfg.get('contexts', [])) != 1
            or cfg['contexts'][0]['name'] != CONTEXT):
        raise ValueError('Unexpected Kubernetes context')
    cluster_name = cfg['contexts'][0]['context']['cluster']
    clusters = [c['cluster'] for c in cfg.get('clusters', []) if c['name'] == cluster_name]
    if cluster_name != CONTEXT or len(clusters) != 1:
        raise ValueError('Unexpected kind cluster reference')
    cluster = clusters[0]
    server = urlsplit(cluster['server'])
    if (server.scheme != 'https' or server.hostname not in ('127.0.0.1', 'localhost', '::1')
            or not server.port or server.username or server.password
            or server.path or server.query or server.fragment
            or not cluster.get('certificate-authority-data')
            or cluster.get('insecure-skip-tls-verify') or cluster.get('proxy-url')):
        raise ValueError('Refusing non-loopback or insecure Kubernetes API')
    return cluster


def output_path(identity):
    runtime = Path(os.environ.get('WJAX_DEMO_RUNTIME_DIR', ROOT / '.wjax-local-runtime')).expanduser()
    name = 'wjax-reader.kubeconfig' if identity == 'reader' else '.demo-kubeconfig.json'
    override = os.environ.get('OUT') if identity == 'reader' else None
    # Do not resolve the final filename: preserve symlinks so lexists detects them.
    path = Path(override).expanduser() if override else runtime / name
    return path.absolute()


def permissions(identity):
    if identity == 'reader':
        return [(verb, resource, True) for verb in ('get', 'list')
                for resource in ('pods', 'deployments.apps')] + [
            (verb, resource, False) for verb, resource in (
                ('create', 'deployments.apps'), ('patch', 'deployments.apps/wjax-nginx'),
                ('update', 'deployments.apps/wjax-nginx'), ('delete', 'pods'),
                ('get', 'secrets'), ('list', 'events'))]
    return [(v, 'deployments.apps/wjax-nginx', True) for v in ('get', 'patch', 'update')] + [
        ('create', 'deployments.apps', True), ('list', 'pods', True),
        ('delete', 'deployments.apps/wjax-nginx', False),
        ('delete', 'namespaces', False), ('get', 'secrets', False),
        ('patch', 'deployments.apps/other-workload', False)]


def check_permissions(config, identity):
    checks = [(v, r, NS, yes) for v, r, yes in permissions(identity)]
    checks.append(('list', 'pods', 'default', False))
    for verb, resource, namespace, expected in checks:
        result = subprocess.run(['kubectl', '--kubeconfig', str(config), 'auth', 'can-i',
                                 verb, resource, '-n', namespace],
                                text=True, capture_output=True, timeout=20)
        if (result.stdout.strip() != ('yes' if expected else 'no')
                or result.returncode not in ((0,) if expected else (0, 1))):
            raise RuntimeError(f'RBAC check failed: {verb} {resource} in {namespace}')
        print(f'PASS: {verb} {resource} in {namespace}: {result.stdout.strip()}')


def private_directory(path):
    """Open/create parents without following symlinks; return a pinned directory FD.

    Ancestors must be owned by this user or root and not writable by others.
    Root-owned sticky temporary ancestors are allowed. The credential parent
    itself must be user-owned and private. Existing permissions are never changed.
    """
    if '..' in path.parts:
        raise ValueError('Parent traversal is not permitted in credential paths')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open('/', flags)
    try:
        for index, part in enumerate(path.parts[1:]):
            try:
                os.mkdir(part, mode=0o700, dir_fd=directory)
            except FileExistsError:
                pass
            child = os.open(part, flags, dir_fd=directory)
            os.close(directory)
            directory = child
            info = os.fstat(directory)
            final = index == len(path.parts[1:]) - 1
            sticky_root = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            if (info.st_uid not in (0, os.geteuid())
                    or (info.st_mode & 0o022 and not sticky_root)
                    or (final and (info.st_uid != os.geteuid() or info.st_mode & 0o077))):
                raise ValueError('Unsafe credential directory ownership or permissions')
        if path == Path('/'):
            raise ValueError('Root is not a runtime directory')
        return directory
    except BaseException:
        os.close(directory)
        raise


def remove_owned_file(directory, name, original):
    """Remove only the inode exclusively created by this invocation."""
    try:
        current = os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return
    if (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino):
        os.unlink(name, dir_fd=directory)


def setup(identity):
    path = output_path(identity)
    legacy = (HERE / '.demo-kubeconfig.json' if identity == 'executor'
              else HERE / 'reader' / 'wjax-reader.kubeconfig')
    for existing in (path, legacy):
        if os.path.lexists(existing):
            raise FileExistsError(f'Refusing existing credential: {existing}; preserve it and inspect before proceeding')
    context = os.environ.get('KIND_CONTEXT', os.environ.get('WJAX_KUBE_CONTEXT', CONTEXT))
    cluster = validate_cluster(context)  # All validation precedes RBAC/token mutations.
    directory = private_directory(path.parent)
    fd = None
    original = None
    try:
        # Reserve exclusively in the pinned, private directory before mutations.
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=directory)
        original = os.fstat(fd)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w', closefd=False) as stream:
            manifest = HERE / ('rbac.yaml' if identity == 'executor' else 'reader/rbac.yaml')
            run(['kubectl', '--context', CONTEXT, '-n', NS, 'apply', '-f', str(manifest)])
            sa = 'wjax-demo-executor' if identity == 'executor' else 'wjax-console-reader'
            token = run(['kubectl', '--context', CONTEXT, '-n', NS, 'create', 'token', sa, '--duration=8h'])
            if not token:
                raise RuntimeError('TokenRequest returned an empty token')
            cfg = {'apiVersion': 'v1', 'kind': 'Config',
                   'clusters': [{'name': CONTEXT, 'cluster': {
                       'server': cluster['server'],
                       'certificate-authority-data': cluster['certificate-authority-data']}}],
                   'users': [{'name': sa, 'user': {'token': token}}],
                   'contexts': [{'name': CONTEXT, 'context': {
                       'cluster': CONTEXT, 'user': sa, 'namespace': NS}}],
                   'current-context': CONTEXT}
            json.dump(cfg, stream, indent=2)
            stream.flush()
            os.fsync(fd)
        check_permissions(path, identity)
    except BaseException:
        if original is not None:
            remove_owned_file(directory, path.name, original)
        raise
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)
    print(f'{identity} setup PASS: {path} (requested token duration: 8h)')
    print('No application Deployment was modified.')


def main():
    try:
        if sys.argv[1:] == ['validate']:
            validate_cluster(os.environ.get('WJAX_KUBE_CONTEXT', CONTEXT))
            print('Kind-supplied identity, loopback API, CA and namespace: PASS')
        elif sys.argv[1:] in (['reader'], ['executor']):
            setup(sys.argv[1])
        else:
            raise ValueError('Use reader | executor | validate')
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, subprocess.TimeoutExpired):
        # Even JSON parser errors and OS exceptions can contain input data or
        # filenames controlled by another process. Do not echo exception contents.
        sys.exit('Setup stopped: safety validation or provisioning failed; existing credentials preserved.')


if __name__ == '__main__':
    main()
