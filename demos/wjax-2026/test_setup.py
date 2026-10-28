"""Safety tests use mocked kubectl/kind; never contact a cluster."""
import json
import io
from contextlib import ExitStack, redirect_stdout, redirect_stderr
import importlib.util
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch
import setup_identity as setup


def config(server='https://127.0.0.1:6443'):
    return {'current-context': setup.CONTEXT,
            'contexts': [{'name': setup.CONTEXT, 'context': {'cluster': setup.CONTEXT}}],
            'clusters': [{'name': setup.CONTEXT, 'cluster': {
                'server': server, 'certificate-authority-data': 'TEST_CA'}}]}


REAL_RUN = subprocess.run


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='wjax setup spaces ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.env = patch.dict(os.environ, {'WJAX_DEMO_RUNTIME_DIR': str(self.root / 'runtime')}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)
        self.calls = []
        self.cfg = config()
        self.kind_cfg = config()
        self.kind = 'wjax-demo'
        self.deny_error = False
        self.namespace_missing = False
        self.mock = patch.object(setup.subprocess, 'run', side_effect=self.command)
        self.mock.start()
        self.addCleanup(self.mock.stop)

    def command(self, args, **kwargs):
        self.calls.append(args)
        out, code = '', 0
        if args[:3] == ['kind', 'get', 'clusters']:
            out = self.kind
        elif args[:3] == ['kind', 'get', 'kubeconfig']:
            self.assertEqual(args[3:], ['--name', 'wjax-demo'])
            out = json.dumps(self.kind_cfg)
        elif 'config' in args:
            out = json.dumps(self.kind_cfg if '--kubeconfig=/dev/stdin' in args else self.cfg)
        elif 'namespace' in args and 'get' in args:
            code = int(self.namespace_missing)
            out = 'namespace/wjax-demo'
        elif 'token' in args:
            out = 'TEST_TOKEN'
        elif 'can-i' in args:
            identity = 'reader' if 'reader' in Path(args[2]).name else 'executor'
            verb, resource = args[5:7]
            allowed = (verb, resource, True) in setup.permissions(identity) and args[-1] == setup.NS
            out, code = ('yes', 0) if allowed else ('no', 1)
            if self.deny_error and not allowed:
                out, code = '', 1
        return subprocess.CompletedProcess(args, code, out, '')

    def mutations(self):
        return [a for a in self.calls if 'apply' in a or 'token' in a]

    def test_both_identities_runtime_and_permissions(self):
        for identity in ('reader', 'executor'):
            setup.setup(identity)
            path = setup.output_path(identity)
            self.assertEqual(path.parent, self.root / 'runtime')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            data = json.loads(path.read_text())
            self.assertEqual(data['users'][0]['user'], {'token': 'TEST_TOKEN'})
        self.assertTrue(all(setup.CONTEXT in a for a in self.mutations()))
        self.assertFalse(any('scale' in a or 'delete' in a[:4] for a in self.calls))

    def test_reject_foreign_context_before_any_call(self):
        with patch.dict(os.environ, {'KIND_CONTEXT': 'production'}):
            with self.assertRaises(ValueError):
                setup.setup('reader')
        self.assertEqual(self.calls, [])

    def test_invalid_api_before_mutations(self):
        for server in ('https://prod:6443', 'https://127.0.0.1.evil:443',
                       'https://localhost:443@evil:443', 'http://localhost:6443',
                       'https://localhost:443/path', 'https://localhost:443?x=y',
                       'https://localhost', 'https://[::1]:99999'):
            self.cfg = config(server)
            with self.assertRaises(ValueError, msg=server):
                setup.setup('reader')
            self.assertEqual(self.mutations(), [])

    def test_wrong_cluster_context_ca_and_proxy(self):
        variants = []
        wrong = config(); wrong['current-context'] = 'production'; variants.append(wrong)
        wrong = config(); wrong['contexts'][0]['context']['cluster'] = 'production'; variants.append(wrong)
        for key, value in (('certificate-authority-data', ''), ('proxy-url', 'https://evil'),
                           ('insecure-skip-tls-verify', True)):
            wrong = config(); wrong['clusters'][0]['cluster'][key] = value; variants.append(wrong)
        for self.cfg in variants:
            with self.assertRaises(ValueError):
                setup.setup('executor')
        self.assertEqual(self.mutations(), [])

    def test_missing_kind_or_namespace(self):
        self.kind = 'other'
        with self.assertRaises(ValueError):
            setup.setup('executor')
        self.kind = 'wjax-demo'; self.namespace_missing = True
        with self.assertRaises(RuntimeError):
            setup.setup('executor')
        self.assertEqual(self.mutations(), [])

    def test_existing_and_dangling_symlink_preserved(self):
        path = setup.output_path('executor'); path.parent.mkdir()
        path.write_text('preserve')
        with self.assertRaises(FileExistsError):
            setup.setup('executor')
        self.assertEqual(path.read_text(), 'preserve')
        path.unlink(); path.symlink_to(self.root / 'missing')
        with self.assertRaises(FileExistsError):
            setup.setup('executor')
        self.assertTrue(path.is_symlink())
        self.assertEqual(self.calls, [])

    def test_exclusive_creation_race(self):
        def race(*args):
            path = setup.output_path('reader'); path.parent.mkdir(mode=0o700)
            path.write_text('winner')
            return config()['clusters'][0]['cluster']
        with patch.object(setup, 'validate_cluster', side_effect=race):
            with self.assertRaises(FileExistsError):
                setup.setup('reader')
        self.assertEqual(setup.output_path('reader').read_text(), 'winner')
        self.assertEqual(self.mutations(), [])

    def test_paths_independent_of_cwd_and_explicit_overrides(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(setup.output_path('executor'), setup.ROOT / '.wjax-local-runtime/.demo-kubeconfig.json')
        with patch.dict(os.environ, {'OUT': str(self.root / 'custom reader config')}):
            setup.setup('reader')
            self.assertTrue((self.root / 'custom reader config').is_file())

    def test_legacy_credentials_preserved(self):
        with patch.object(setup, 'HERE', self.root):
            legacy = self.root / '.demo-kubeconfig.json'
            legacy.write_text('legacy')
            with self.assertRaises(FileExistsError):
                setup.setup('executor')
            self.assertEqual(legacy.read_text(), 'legacy')
        self.assertEqual(self.calls, [])

    def test_shell_entrypoints_from_other_cwd_and_checkout_with_spaces(self):
        checkout = self.root / 'checkout with spaces'
        demo = checkout / 'demos/wjax-2026'
        (demo / 'reader/scripts').mkdir(parents=True)
        for relative in ('setup.sh', 'setup_identity.py', 'reader/scripts/setup-reader.sh'):
            shutil.copyfile(setup.HERE / relative, demo / relative)
        runtime = checkout / '.wjax-local-runtime'
        runtime.mkdir()
        for filename in ('wjax-reader.kubeconfig', '.demo-kubeconfig.json'):
            (runtime / filename).write_text('preserve')
        # Use real shells/Python, with an unrelated CWD and no runtime override.
        env = {k: v for k, v in os.environ.items() if k not in
               ('WJAX_DEMO_RUNTIME_DIR', 'OUT', 'KIND_CONTEXT', 'WJAX_KUBE_CONTEXT')}
        for wrapper in ('setup.sh', 'reader/scripts/setup-reader.sh'):
            result = REAL_RUN(['/bin/sh', str(demo / wrapper)] if wrapper.startswith('reader')
                              else ['/bin/bash', str(demo / wrapper)],
                              cwd=self.root, env=env, text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('existing credentials preserved', result.stderr)
        for path in runtime.iterdir():
            self.assertEqual(path.read_text(), 'preserve')

    def test_kind_api_or_ca_mismatch_before_mutations(self):
        for key, value in (('server', 'https://127.0.0.1:7443'),
                           ('certificate-authority-data', 'DIFFERENT_CA')):
            with self.subTest(key=key):
                self.kind_cfg = config()
                self.kind_cfg['clusters'][0]['cluster'][key] = value
                with self.assertRaises(ValueError):
                    setup.setup('reader')
                self.assertEqual(self.mutations(), [])
                self.assertFalse(setup.output_path('reader').exists())

    def test_kind_context_and_cluster_mismatch_before_mutations(self):
        for target in ('current-context', 'context-name', 'cluster-name'):
            self.kind_cfg = config()
            if target == 'current-context':
                self.kind_cfg['current-context'] = 'other'
            elif target == 'context-name':
                self.kind_cfg['contexts'][0]['name'] = 'other'
            else:
                self.kind_cfg['contexts'][0]['context']['cluster'] = 'other'
            with self.assertRaises(ValueError):
                setup.setup('executor')
        self.assertEqual(self.mutations(), [])

    def test_kind_export_failure_or_malformed_config_before_mutations(self):
        original = self.command
        for malformed in (False, True):
            def command(args, **kwargs):
                if args[:3] == ['kind', 'get', 'kubeconfig']:
                    return subprocess.CompletedProcess(args, 0 if malformed else 1,
                                                       'not a kubeconfig', 'secret error')
                if '--kubeconfig=/dev/stdin' in args:
                    return subprocess.CompletedProcess(args, 1, '', 'parse error')
                return original(args, **kwargs)
            with patch.object(setup.subprocess, 'run', side_effect=command):
                with self.assertRaises(RuntimeError):
                    setup.setup('reader')
        self.assertEqual(self.mutations(), [])

    def test_namespace_response_must_be_exact(self):
        original = self.command
        def command(args, **kwargs):
            if 'namespace' in args and 'get' in args:
                return subprocess.CompletedProcess(args, 0, 'namespace/other', '')
            return original(args, **kwargs)
        with patch.object(setup.subprocess, 'run', side_effect=command):
            with self.assertRaises(ValueError):
                setup.setup('executor')
        self.assertEqual(self.mutations(), [])

    def test_unsafe_runtime_modes_are_not_modified(self):
        runtime = self.root / 'runtime'
        runtime.mkdir(mode=0o700)
        for mode in (0o755, 0o770, 0o777):
            runtime.chmod(mode)
            with self.assertRaises(ValueError):
                setup.setup('reader')
            self.assertEqual(runtime.stat().st_mode & 0o777, mode)
            self.assertEqual(list(runtime.iterdir()), [])
        runtime.chmod(0o700)
        self.assertEqual(self.mutations(), [])

    def test_symlinked_runtime_and_ancestor_are_rejected(self):
        target = self.root / 'target'; target.mkdir(mode=0o700)
        runtime = self.root / 'runtime'; runtime.symlink_to(target, target_is_directory=True)
        for selected in (runtime, runtime / 'nested'):
            with patch.dict(os.environ, {'WJAX_DEMO_RUNTIME_DIR': str(selected)}):
                with self.assertRaises(OSError):
                    setup.setup('executor')
        self.assertEqual(list(target.iterdir()), [])
        self.assertEqual(self.mutations(), [])

    def test_writable_ancestor_is_rejected(self):
        runtime = self.root / 'runtime'
        runtime.mkdir(mode=0o777); runtime.chmod(0o777)
        with patch.dict(os.environ, {'WJAX_DEMO_RUNTIME_DIR': str(runtime / 'nested')}):
            with self.assertRaises(ValueError):
                setup.setup('executor')
        self.assertFalse((runtime / 'nested').exists())
        self.assertEqual(self.mutations(), [])

    def test_parent_traversal_is_rejected(self):
        with patch.dict(os.environ, {'WJAX_DEMO_RUNTIME_DIR': str(self.root / 'unused/../runtime')}):
            with self.assertRaises(ValueError):
                setup.setup('reader')
        self.assertFalse((self.root / 'runtime').exists())
        self.assertEqual(self.mutations(), [])

    def test_wrong_owner_is_rejected(self):
        stat_call = setup.os.fstat
        def wrong_owner(fd):
            info = stat_call(fd)
            values = list(info)
            values[4] = os.geteuid() + 10000  # st_uid
            return os.stat_result(values)
        with patch.object(setup.os, 'fstat', side_effect=wrong_owner):
            with self.assertRaises(ValueError):
                setup.setup('reader')
        self.assertEqual(self.mutations(), [])

    def test_failure_cleanup_at_every_provisioning_stage(self):
        original_run = setup.run
        for identity in ('reader', 'executor'):
            for stage in ('apply', 'token', 'empty-token', 'timeout', 'json', 'fsync', 'permissions'):
                with self.subTest(identity=identity, stage=stage):
                    def command(args, **kwargs):
                        if stage == 'apply' and 'apply' in args:
                            raise RuntimeError('provisioning failed')
                        if stage in ('token', 'timeout') and 'token' in args:
                            if stage == 'timeout':
                                raise subprocess.TimeoutExpired(args, 20)
                            raise RuntimeError('TokenRequest failed')
                        if stage == 'empty-token' and 'token' in args:
                            return ''
                        return original_run(args, **kwargs)
                    with ExitStack() as patches:
                        patches.enter_context(patch.object(setup, 'run', side_effect=command))
                        if stage == 'json':
                            def partial_write(cfg, stream, **kwargs):
                                stream.write('partial credential contents')
                                raise OSError('write failed')
                            patches.enter_context(patch.object(setup.json, 'dump', side_effect=partial_write))
                        if stage == 'fsync':
                            patches.enter_context(patch.object(setup.os, 'fsync', side_effect=OSError('flush failed')))
                        if stage == 'permissions':
                            patches.enter_context(patch.object(setup, 'check_permissions', side_effect=RuntimeError('verification failed')))
                        with self.assertRaises((RuntimeError, OSError, subprocess.TimeoutExpired)):
                            setup.setup(identity)
                    self.assertFalse(os.path.lexists(setup.output_path(identity)))

    def test_cleanup_keeps_preexisting_other_identity(self):
        runtime = self.root / 'runtime'; runtime.mkdir(mode=0o700)
        existing = runtime / '.demo-kubeconfig.json'
        existing.write_text('working M5 credential stand-in'); existing.chmod(0o600)
        with patch.object(setup, 'check_permissions', side_effect=RuntimeError('verification failed')):
            with self.assertRaises(RuntimeError):
                setup.setup('reader')
        self.assertFalse(setup.output_path('reader').exists())
        self.assertEqual(existing.read_text(), 'working M5 credential stand-in')
        self.assertEqual(existing.stat().st_mode & 0o777, 0o600)

    def test_cleanup_never_unlinks_replacement_or_symlink(self):
        path = setup.output_path('reader')
        target = self.root / 'untouched'; target.write_text('untouched')
        for symlink in (False, True):
            def replace(*args):
                # Keep original inode allocated, so replacement cannot reuse it.
                path.rename(path.with_name('original'))
                if symlink:
                    path.symlink_to(target)
                else:
                    path.write_text('replacement')
                raise RuntimeError('verification failed')
            with patch.object(setup, 'check_permissions', side_effect=replace):
                with self.assertRaises(RuntimeError):
                    setup.setup('reader')
            self.assertTrue(os.path.lexists(path))
            self.assertEqual(path.read_text(), 'untouched' if symlink else 'replacement')
            self.assertEqual(target.read_text(), 'untouched')
            path.unlink(); path.with_name('original').unlink()

    def test_new_runtime_private_even_with_permissive_umask(self):
        previous = os.umask(0)
        try:
            setup.setup('reader')
        finally:
            os.umask(previous)
        self.assertEqual(setup.output_path('reader').parent.stat().st_mode & 0o777, 0o700)
        self.assertEqual(setup.output_path('reader').stat().st_mode & 0o777, 0o600)

    def test_cli_does_not_log_credentials_from_exceptions(self):
        for error in (ValueError('SECRET_TOKEN'), OSError('SECRET_TOKEN'),
                      subprocess.TimeoutExpired(['kubectl'], 20, output='SECRET_TOKEN')):
            output = io.StringIO()
            with patch.object(setup.sys, 'argv', ['setup_identity.py', 'reader']), redirect_stdout(output), redirect_stderr(output):
                with patch.object(setup, 'setup', side_effect=error):
                    with self.assertRaises(SystemExit) as stopped:
                        setup.main()
            self.assertNotIn('SECRET_TOKEN', output.getvalue() + str(stopped.exception))

    def test_negative_rbac_errors_fail_closed(self):
        self.deny_error = True
        with self.assertRaises(RuntimeError):
            setup.setup('reader')
        self.assertFalse(setup.output_path('reader').exists())


class LauncherSafetyTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('wjax_launcher_test', setup.ROOT / 'scripts/wjax_launcher.py')
        self.launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.launcher)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.launcher.EXECUTOR_CONFIG = Path(self.temp.name) / 'executor.json'
        self.launcher.EXECUTOR_CONFIG.write_text('{}')

    def test_unauthorized_is_not_a_negative_rbac_pass(self):
        def command(args):
            if 'get' in args and 'auth' not in args:
                return subprocess.CompletedProcess(args, 0, 'deployment.apps/wjax-nginx', '')
            if 'delete' in args or any('not-wjax-nginx' in a for a in args):
                return subprocess.CompletedProcess(args, 1, '', 'Unauthorized')
            return subprocess.CompletedProcess(args, 0, 'yes', '')
        with patch.object(self.launcher, 'run_command', side_effect=command):
            self.assertFalse(self.launcher.executor_check())

    def test_failed_cluster_validation_never_requests_token(self):
        with patch.object(self.launcher, 'run_command', return_value=
                          subprocess.CompletedProcess([], 1, '', '')) as command:
            self.assertEqual(self.launcher.refresh_executor_auth(), 1)
        self.assertEqual(command.call_count, 1)
        self.assertEqual(command.call_args.args[0][-1], 'validate')

    def test_foreign_context_never_requests_token(self):
        self.launcher.KUBE_CONTEXT = 'production'
        with patch.object(self.launcher, 'run_command') as command:
            self.assertEqual(self.launcher.refresh_executor_auth(), 1)
        command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
