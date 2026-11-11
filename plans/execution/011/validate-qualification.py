"""Validate retained qualification receipts/bytes without reinstalling or rerunning tests."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
folder = root / 'plans/execution/011'
meta = json.loads((folder / 'worker.json').read_text())
worktree = Path(meta['worktree'])
baseline = meta['baselineHashes']
allowed = set(meta['allowedPaths'])
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
checks = {}
checks['original-74-source-files-preserved'] = all(sha(root / f) == digest for f, digest in baseline.items())
checks['candidate-71-other-files-identical'] = all(sha(worktree / f) == digest for f, digest in baseline.items() if f not in allowed)
changed = {f for f, digest in baseline.items() if sha(worktree / f) != digest}
extras = {f for f in subprocess.check_output(['git','ls-files','--others','--exclude-standard'],cwd=worktree,text=True).splitlines() if f not in baseline}
checks['exactly-three-approved-paths'] = changed == allowed and len(allowed) == 3 and not extras
old_manifest = json.loads((worktree / '.pi/baseline/package.json').read_text())
expected = json.loads(json.dumps(old_manifest))
for name in ['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','@earendil-works/pi-tui']:
    expected['devDependencies'][name] = '1.5.2'
checks['only-three-dev-pins-public-contracts-unchanged'] = json.loads((worktree / 'package.json').read_text()) == expected
old = json.loads((worktree / '.pi/baseline/package-lock.json').read_text())['packages']
new = json.loads((worktree / 'package-lock.json').read_text())['packages']
def resolve(packages, parent, name):
    p = PurePosixPath(parent)
    for ancestor in [p, *p.parents]:
        key = (str(ancestor) + '/' if str(ancestor) != '.' else '') + 'node_modules/' + name
        if key in packages:
            return key
    raise KeyError((parent, name))
def closure(packages, names):
    todo = [resolve(packages, '', name) for name in names]
    seen = set()
    while todo:
        path = todo.pop()
        if path in seen:
            continue
        seen.add(path)
        entry = packages[path]
        for name in {**entry.get('dependencies', {}), **entry.get('optionalDependencies', {}), **entry.get('peerDependencies', {})}:
            try:
                todo.append(resolve(packages, path, name))
            except KeyError:
                if name not in entry.get('optionalDependencies', {}) and not entry.get('peerDependenciesMeta', {}).get(name, {}).get('optional'):
                    raise
    return seen
prod_old = closure(old, old['']['dependencies'])
prod_new = closure(new, new['']['dependencies'])
checks['all-94-production-entries-identical-in-full'] = prod_old == prod_new and len(prod_old) == 94 and all(old[p] == new[p] for p in prod_old)
pi = ['@earendil-works/pi-ai','@earendil-works/pi-coding-agent','@earendil-works/pi-tui']
pi_paths = closure(old, pi) | closure(new, pi)
deltas = {p for p in old.keys() | new.keys() if old.get(p) != new.get(p)}
checks['155-lock-deltas-only-pi-development-closure'] = len(deltas) == 155 and deltas <= pi_paths | {''}
for name, version in {'undici':'8.12.3','brace-expansion':'5.0.12','minimatch':'11.0.3', **{name:'1.5.2' for name in pi}}.items():
    versions = [entry['version'] for p, entry in new.items() if p.endswith('/' + name)]
    checks['resolved:' + name] = versions == [version]
for name in ['reviewer-lock-resolution','reviewer-locked-install','reviewer-typecheck','reviewer-focused','reviewer-full','reviewer-pack-check']:
    checks[name + ':exit0'] = (worktree / '.pi' / (name + '.exit')).read_text().strip() == '0'
for name, count in [('reviewer-focused',99), ('reviewer-full',341)]:
    content = (worktree / '.pi' / (name + '.log')).read_text()
    checks[name + ':counts'] = all(re.search(r'^# ' + k + ' ' + str(v) + '$', content, re.M) for k,v in {'tests':count,'pass':count,'fail':0,'cancelled':0,'skipped':0}.items())
ids = {row['id'] for row in json.loads((folder / 'primary-advisories.json').read_text())}
ids.add(json.loads((folder / 'related-minimatch-advisory.json').read_text())['id'])
for name in ['reviewer-audit-all','reviewer-audit-prod']:
    data = json.loads((worktree / '.pi' / (name + '.json')).read_text())
    v = data['metadata']['vulnerabilities']
    checks[name + ':0-high-critical-4-moderate'] = v['high'] == 0 and v['critical'] == 0 and v['moderate'] == 4
    observed = {a['url'].rsplit('/',1)[-1] for entry in data['vulnerabilities'].values() for a in entry.get('via', []) if isinstance(a, dict)}
    checks[name + ':all12-target-ids-absent'] = len(ids) == 12 and not ids & observed
bundle = json.loads((worktree / '.pi/bundle-evidence.json').read_text())
checks['reachable-iterative-brace-parser-recorded'] = any(p['reachable'] and 'for(;;)' in p['parser'] and 'parseCommaParts(post)' not in p['parser'] for p in bundle['parsers']) and not bundle['legacyRecursiveRemainderMatches']
checks['embedded-undici-gap-not-hidden'] = bundle['embeddedUndiciIndependentlyAttested'] is False and 'embedded Undici is not independently attested' in (worktree / 'README.md').read_text()
checks['cold-final-review-approved'] = (folder / 'final-review.exit').read_text().strip() == '0' and (folder / 'final-review.md').read_text().startswith('**APPROVE**')
patch = root / meta['patch']
checks['patch-identity'] = sha(patch) == meta['patchSha256']
checks['patch-applies-check-only'] = subprocess.run(['git','apply','--check',str(patch)],cwd=root,check=False).returncode == 0
copy = Path(tempfile.mkdtemp(prefix='patch-roundtrip-',dir=worktree.parent))
for name in allowed:
    target = copy / name
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_bytes((worktree / '.pi/baseline' / name).read_bytes())
subprocess.run(['git','apply',str(patch)],cwd=copy,check=True)
checks['patch-roundtrip-identical-to-qualified-files'] = all(sha(copy / name) == sha(worktree / name) for name in allowed)
integration = json.loads((root / 'plans/execution/010/integration.json').read_text())
h = hashlib.sha256()
count = 0
for directory, dirs, files in os.walk(root / 'node_modules',followlinks=False):
    for name in sorted(dirs + files):
        path = Path(directory) / name
        stat = path.lstat()
        value = [str(path.relative_to(root / 'node_modules')),stat.st_mode,stat.st_size,stat.st_mtime_ns,os.readlink(path) if path.is_symlink() else None]
        h.update(json.dumps(value,separators=(',',':')).encode())
        count += 1
checks['original-installed-dependencies-preserved'] = {'sha256':h.hexdigest(),'entries':count} == integration['dependencyFingerprintBefore']
checks['original-and-candidate-staging-empty'] = all(subprocess.run(['git','diff','--cached','--quiet'],cwd=p,check=False).returncode == 0 for p in [root,worktree])
checks['candidate-whitespace-clean'] = subprocess.run(['git','diff','--check'],cwd=worktree,check=False).returncode == 0
result = {'checks':checks,'roundtripCopy':str(copy),'patchSha256':sha(patch),'qualification':'isolated exact1.5.2 dev fixture; embedded Undici not independently attested','softwareGate':'actual retained receipts checked; not rerun by this validator'}
(folder / 'qualification-validation.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
if not all(checks.values()):
    raise SystemExit('Qualification validation failed: ' + ', '.join(k for k, ok in checks.items() if not ok))
print(f'PASS: {len(checks)} qualification artifact/scope/receipt checks')
