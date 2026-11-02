"""Regression-test the exact inline gate used by CI, without third-party dependencies."""
import itertools
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import textwrap

workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/ci.yml').read_text()
gate = textwrap.dedent(workflow.split("          python3 - <<'PYTHON'\n", 1)[1].split("          PYTHON", 1)[0])
jobs = ['check', 'compatibility', 'mcp-windows', 'prepared-action']
summary_needs = re.search(r'^    needs: \[(.+)\]$', workflow, re.MULTILINE)
assert summary_needs and summary_needs.group(1).split(', ') == jobs, 'Summary dependencies changed'
windows = workflow.split('  mcp-windows:\n', 1)[1].split('\n  prepared-action:', 1)[0]
assert '    runs-on: windows-latest\n' in windows
assert "node: ${{ fromJSON(github.event_name == 'pull_request' && '[22]' || '[22, 24]') }}" in windows
assert '      - run: node --test test/package-process.test.mjs test/package-contract-runner.test.mjs\n' in windows
assert '      - run: node scripts/test-package-smoke.mjs\n' in windows
assert windows.count('      - run: npm run build\n') == 1
assert 'continue-on-error:' not in windows and 'if:' not in windows, 'Windows package gate must be required'
# Every dependency-installing job must establish and exercise the supported npm first.
# This deliberately checks ordered, unconditional steps rather than just the presence
# of a version string somewhere in the workflow. Existing job topology stays intact.
def check_dependency_policy(source):
    blocks = re.findall(r'^  ([a-z][a-z0-9-]*):\n(.*?)(?=^  [a-z][a-z0-9-]*:\n|\Z)',
                        source, re.MULTILINE | re.DOTALL)
    installing = [(name, body) for name, body in blocks if '      - run: npm ci\n' in body]
    assert [name for name, _ in installing] == jobs, 'Dependency-install job inventory changed'
    required = ('      - name: Install policy-aware npm\n'
                '        run: npm install --global npm@11.17.0 --ignore-scripts --no-audit --no-fund\n'
                '      - name: Verify dependency resolution policy\n'
                '        run: node scripts/verify-dependency-policy.mjs npm\n'
                '      - run: npm ci\n')
    for name, body in installing:
        assert required in body, f'{name}: supported npm and passing policy fixture must precede npm ci'
        assert body.count('      - run: npm ci\n') == 1
        before_bootstrap = body.split('      - name: Install policy-aware npm\n', 1)[0]
        assert not re.search(r"^\s+cache:\s*['\"]?npm['\"]?\s*(?:#.*)?$",
                             before_bootstrap, re.MULTILINE), f'{name}: cache discovery must not invoke old npm before bootstrap'
        assert 'continue-on-error:' not in body, f'{name}: dependency policy must be required'

check_dependency_policy(workflow)
for old, new in [
    ('npm@11.17.0', 'npm@11.9.0'),
    ('      # Pinned mature npm supports the cooldown and exact trusted-package exception.\n',
     '          cache: npm\n      # Pinned mature npm supports the cooldown and exact trusted-package exception.\n'),
    ('        run: node scripts/verify-dependency-policy.mjs npm\n', ''),
    ('      - name: Verify dependency resolution policy\n',
     '      - name: Verify dependency resolution policy\n        if: false\n'),
]:
    try:
        check_dependency_policy(workflow.replace(old, new, 1))
    except AssertionError:
        pass
    else:
        raise AssertionError('Dependency policy regression was not rejected')

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
