"""Validate local application receipts without reinstalling dependencies or rerunning tests."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import re
import subprocess

root = Path(__file__).resolve().parents[3]
path = root / 'plans/execution/010/integration.json'
meta = json.loads(path.read_text())
checks = {}
checks['all-74-files-match-reviewed-stack'] = len(meta['expectedHashes']) == 74 and all(
    hashlib.sha256((root / f).read_bytes()).hexdigest() == digest
    for f, digest in meta['expectedHashes'].items()
)
# Same metadata-only traversal as the pre-application snapshot; do not read
# dependency file contents or follow symlink directories.
h = hashlib.sha256()
count = 0
for directory, dirs, files in os.walk(root / 'node_modules', followlinks=False):
    for name in sorted(dirs + files):
        file = Path(directory) / name
        stat = file.lstat()
        value = [str(file.relative_to(root / 'node_modules')), stat.st_mode, stat.st_size,
                 stat.st_mtime_ns, os.readlink(file) if file.is_symlink() else None]
        h.update(json.dumps(value, separators=(',', ':')).encode())
        count += 1
fingerprint = {'sha256': h.hexdigest(), 'entries': count}
checks['installed-dependency-tree-preserved'] = fingerprint == meta['dependencyFingerprintBefore']
checks['head-unchanged-no-commit'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip() == meta['headBefore']
checks['staging-empty'] = subprocess.run(['git', 'diff', '--cached', '--quiet'], cwd=root, check=False).returncode == 0
checks['diff-whitespace-clean'] = subprocess.run(['git', 'diff', '--check'], cwd=root, check=False).returncode == 0
changed = set(subprocess.check_output(['git', 'diff', '--name-only', 'HEAD'], cwd=root, text=True).splitlines())
created = set(meta['expectedHashes']) - set(meta['beforeHashes'])
expected_changed = {f for f, digest in meta['beforeHashes'].items() if meta['expectedHashes'].get(f, digest) != digest}
checks['exactly-reviewed-tracked-changes'] = changed == expected_changed
checks['three-reviewed-new-source-files'] = created == {'extensions/lib/bridge-input-budget.ts', 'tests/bridge-input-budget.test.ts', 'tests/timing-helpers.ts'}
evidence = Path(meta['evidenceDir'])
for name in ['resolutions', 'full-test', 'typecheck', 'pack-check']:
    checks[name + ':exit0'] = (evidence / (name + '.exit')).read_text().strip() == '0'
full = (evidence / 'full-test.log').read_text()
checks['341-tests-no-failures-or-skips'] = all(
    re.search(r'^# ' + key + ' ' + str(value) + r'$', full, re.M)
    for key, value in {'tests':341, 'pass':341, 'fail':0, 'cancelled':0, 'skipped':0}.items()
)
checks['no-missing-required-package-paths'] = not meta['missingNonoptionalPackagePaths']
result = {'checks': checks, 'dependencyFingerprintAfterVerification': fingerprint,
          'installedLockDriftCount': len(meta['installedLockDrift']),
          'qualification': 'original gate used preserved installed graph; clean locked-install proof belongs to isolated010'}
(root / 'plans/execution/010/integration-validation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
if not all(checks.values()):
    raise SystemExit('Integration validation failed: ' + ', '.join(k for k, ok in checks.items() if not ok))
meta.update({'state':'applied_verified', 'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
             'dependencyFingerprintAfterVerification':fingerprint, 'verificationChecks':checks,
             'pendingQuestions':False, 'sourceChangeCount':len(changed) + len(created)})
path.write_text(json.dumps(meta, indent=2) + '\n')
print(f'PASS: {len(checks)} integration checks; no installs or repeated software gates')
