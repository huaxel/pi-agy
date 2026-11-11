"""Check retained integration receipts and backup integrity without installs/test reruns."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import re
import subprocess

root = Path(__file__).resolve().parents[3]
record_path = root / 'plans/execution/011/integration.json'
meta = json.loads(record_path.read_text())
backup = Path(meta['backupRoot'])
checks = {}
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
checks['all-74-original-files-match-qualified-stack'] = len(meta['expectedHashes']) == 74 and all(sha(root / f) == digest for f, digest in meta['expectedHashes'].items())
checks['before-source-copies-retained'] = all(sha(backup / 'source' / name) == meta['sourceBeforeHashes'][name] for name in ['package.json','package-lock.json','README.md'])
hash_state = hashlib.sha256()
count = 0
old_modules = Path(meta['originalNodeModulesBackup'])
for directory, dirs, files in os.walk(old_modules, followlinks=False):
    for name in sorted(dirs + files):
        path = Path(directory) / name
        stat = path.lstat()
        value = [str(path.relative_to(old_modules)), stat.st_mode, stat.st_size, stat.st_mtime_ns, os.readlink(path) if path.is_symlink() else None]
        hash_state.update(json.dumps(value, separators=(',', ':')).encode())
        count += 1
checks['old-33428-entry-install-archive-intact'] = {'sha256':hash_state.hexdigest(),'entries':count} == meta['oldDependencyFingerprint'] and count == 33428
lock = json.loads((root / 'package-lock.json').read_text())['packages']
drift = []
missing = []
for name, entry in lock.items():
    if not name:
        continue
    package = root / name / 'package.json'
    if package.exists():
        version = json.loads(package.read_text()).get('version')
        if version != entry.get('version'):
            drift.append({'path':name,'locked':entry.get('version'),'installed':version})
    elif not entry.get('optional') and not entry.get('devOptional'):
        missing.append(name)
checks['no-installed-lock-version-drift'] = not drift
checks['no-missing-nonoptional-lock-paths'] = not missing
for name, version in {'@earendil-works/pi-ai':'1.5.2','@earendil-works/pi-coding-agent':'1.5.2','@earendil-works/pi-tui':'1.5.2','undici':'8.12.3','minimatch':'11.0.3','brace-expansion':'5.0.12','@modelcontextprotocol/sdk':'1.32.2','zod':'4.6.7','body-parser':'2.4.0'}.items():
    checks['installed:' + name] = json.loads((root / 'node_modules' / name / 'package.json').read_text())['version'] == version
logs = backup / 'logs'
for name in ['install','resolutions','full-test','typecheck','pack-check']:
    checks[name + ':exit0'] = (logs / (name + '.exit')).read_text().strip() == '0'
full = (logs / 'full-test.log').read_text()
checks['341-tests-no-failures-cancellations-skips'] = all(re.search(r'^# ' + name + ' ' + str(value) + '$', full, re.M) for name,value in {'tests':341,'pass':341,'fail':0,'cancelled':0,'skipped':0}.items())
ids = {a['id'] for a in json.loads((root / 'plans/execution/011/primary-advisories.json').read_text())}
ids.add(json.loads((root / 'plans/execution/011/related-minimatch-advisory.json').read_text())['id'])
for name in ['audit-all','audit-prod']:
    data = json.loads((logs / (name + '.json')).read_text())
    v = data['metadata']['vulnerabilities']
    checks[name + ':0-high-critical-4-moderate'] = v['high'] == 0 and v['critical'] == 0 and v['moderate'] == 4
    observed = {a['url'].rsplit('/',1)[-1] for p in data['vulnerabilities'].values() for a in p.get('via',[]) if isinstance(a,dict)}
    checks[name + ':all12-target-ids-absent'] = len(ids) == 12 and not ids & observed
checks['head-unchanged-no-commit'] = subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip() == meta['headBefore']
checks['staging-empty'] = subprocess.run(['git','diff','--cached','--quiet'],cwd=root,check=False).returncode == 0
checks['diff-whitespace-clean'] = subprocess.run(['git','diff','--check'],cwd=root,check=False).returncode == 0
result = {'checks':checks,'installedLockDrift':drift,'missingNonoptionalPaths':missing,'backup':str(old_modules),'softwareGate':'retained actual receipts checked; no installs/test reruns by this validator'}
(root / 'plans/execution/011/integration-validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
if not all(checks.values()):
    raise SystemExit('Integration validation failed: ' + ', '.join(k for k, ok in checks.items() if not ok))
meta.update({'state':'applied_installed_verified','pendingQuestions':False,'completedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'validationChecks':len(checks),'installedLockDrift':drift,'missingNonoptionalPaths':missing,'backupIntegrity':'metadata fingerprint identical; original tree atomically renamed, not deleted'})
record_path.write_text(json.dumps(meta,indent=2)+'\n')
print(f'PASS: {len(checks)} installation/integration/backup checks')
