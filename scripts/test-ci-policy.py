"""Regression-test the exact inline gate used by CI, without third-party dependencies."""
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import textwrap

workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/ci.yml').read_text()
gate = textwrap.dedent(workflow.split("          python3 - <<'PYTHON'\n", 1)[1].split("          PYTHON", 1)[0])
jobs = ['check', 'compatibility', 'mcp-windows', 'prepared-action']
count = 0

def check(event, needs, accepted):
    global count
    result = subprocess.run([sys.executable, '-c', gate], capture_output=True,
                            env={**os.environ, 'EVENT_NAME': event, 'NEEDS_JSON': json.dumps(needs)})
    assert (result.returncode == 0) == accepted, (event, needs, result.stderr.decode())
    count += 1

for event in ['pull_request', 'push', 'workflow_dispatch']:
    expected = dict.fromkeys(jobs, 'success')
    if event != 'pull_request':
        expected['compatibility'] = 'skipped'
    for results in itertools.product(['success', 'failure', 'cancelled', 'skipped'], repeat=len(jobs)):
        statuses = dict(zip(jobs, results))
        check(event, {job: {'result': value} for job, value in statuses.items()}, statuses == expected)
    valid = {job: {'result': value} for job, value in expected.items()}
    for job in jobs:
        check(event, {key: value for key, value in valid.items() if key != job}, False)
        check(event, {**valid, job: {}}, False)
    check(event, {**valid, 'unexpected': {'result': 'success'}}, False)
check('schedule', {job: {'result': 'success'} for job in jobs}, False)
print(f'CI gate policy passed {count} cases')
