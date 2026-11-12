"""Disposable integration-test driver; credentials arrive on stdin, never argv."""
import errno
import json
import os
import pty
import select
import sys
import time

request = json.load(sys.stdin)
child, terminal = pty.fork()
if child == 0:
    os.execv(request['node'], [request['node'], request['cli'], *request['args']])
output = b''
prompts = [p.encode() for p in request.get('prompts', ['Administrator password: '])]
if 'prompts' not in request and request['args'][0] in ('initialize', 'create', 'recover'):
    prompts.extend([b'New account password (15+ characters): ', b'Confirm new account password: '])
index = 0
deadline = time.monotonic() + 20
while time.monotonic() < deadline:
    if not select.select([terminal], [], [], 0.5)[0]:
        continue
    try:
        chunk = os.read(terminal, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            break
        raise
    if not chunk:
        break
    output += chunk
    if index < len(prompts) and prompts[index] in output:
        os.write(terminal, request['password'].encode() + b'\r')
        index += 1
else:
    os.kill(child, 9)
    raise RuntimeError('CLI timed out: ' + output.decode(errors='replace').replace(request['password'], '[redacted]'))
_, status = os.waitpid(child, 0)
os.close(terminal)
assert request['password'].encode() not in output, 'Credential echoed by CLI'
assert os.waitstatus_to_exitcode(status) == 0, 'CLI failed'
sys.stdout.buffer.write(output)
