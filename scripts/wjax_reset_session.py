#!/usr/bin/env python3
"""Archive only the local W-JAX evidence ledger for a fresh demo session.

Run after the W-JAX stack is stopped. Never modify credentials or Kubernetes.
"""
import argparse
from datetime import datetime, timezone
import os
from pathlib import Path
import stat
import sys


def reset(runtime: Path) -> int:
    runtime = runtime.absolute()
    if runtime.is_symlink():
        raise RuntimeError('Runtime directory must not be a symlink')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(runtime, flags)
    try:
        ds = os.fstat(directory)
        if ds.st_uid != os.geteuid() or ds.st_mode & 0o077:
            raise RuntimeError('Runtime directory must be owned by the current user and mode 0700')
        try:
            fd = os.open('evidence.jsonl', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        except FileNotFoundError:
            print('No active evidence.jsonl; session is already reset.')
            return 0
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
                raise RuntimeError('Refusing unsafe evidence file (type, owner, or link count)')
            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            archive = f'evidence-{stamp}-{os.getpid()}.jsonl'
            # Hard-link with exclusive destination, then unlink original. Both names
            # refer to the identical inode; no evidence is copied or overwritten.
            os.link('evidence.jsonl', archive, src_dir_fd=directory,
                    dst_dir_fd=directory, follow_symlinks=False)
            try:
                os.fchmod(fd, 0o600)
                os.unlink('evidence.jsonl', dir_fd=directory)
            except BaseException:
                os.unlink(archive, dir_fd=directory)
                raise
            print(f'Archived evidence.jsonl -> {runtime / archive}')
            print('New session ready. Kubernetes cluster, workload, and credentials unchanged.')
            return 0
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime-dir', required=True, type=Path)
    args = parser.parse_args()
    try:
        return reset(args.runtime_dir)
    except (OSError, RuntimeError) as exc:
        print(f'ERROR: reset aborted; existing evidence preserved: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
