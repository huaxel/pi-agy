"""Validate retained 010 artifacts and receipts; does not rerun the software gate."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
meta = json.loads((root / 'plans/execution/010/implementation.json').read_text())
worktree = Path(meta['worktree'])
base = Path(meta['acceptedBaseline'])
allowed = set(meta['incrementalPaths'])
checks = {}
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
checks['approved-state'] = meta['state'] == 'approved' and not meta['pendingQuestions']
checks['final-source-identities'] = all(sha(worktree / f) == digest for f, digest in meta['finalHashes'].items())
checks['accepted-baseline-preserved'] = all(sha(base / f) == digest for f, digest in meta['baselineHashes'].items())
checks['unchanged-prerequisite-bytes'] = all(sha(worktree / f) == digest for f, digest in meta['baselineHashes'].items() if f not in allowed)
actual = {f for f, digest in meta['baselineHashes'].items() if sha(worktree / f) != digest}
actual.update(f for f in subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'], cwd=worktree, text=True).splitlines() if f not in meta['baselineHashes'])
checks['only-seven-approved-incremental-paths'] = actual == allowed and len(allowed) == 7
patch = root / meta['patch']
checks['patch-identity'] = sha(patch) == meta['patchSha256']
checks['patch-applies-to-accepted-stack'] = subprocess.run(['git', 'apply', '--check', str(patch)], cwd=base, check=False).returncode == 0

# Apply the deliverable to a task-owned plain copy outside any Git worktree,
# then compare every resulting file to the tested source. Never modify base.
roundtrip = Path(tempfile.mkdtemp(prefix='patch-roundtrip-', dir=worktree.parent))
for f in allowed:
    old = worktree / '.pi/baseline' / f
    if old.exists():
        target = roundtrip / f
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(old.read_bytes())
subprocess.run(['git', 'apply', str(patch)], cwd=roundtrip, check=True)
checks['patch-roundtrip-matches-tested-files'] = all(sha(roundtrip / f) == meta['finalHashes'][f] for f in allowed)
for name in ['full-test-isolated', 'final-typecheck', 'pack-check', 'focused', 'consumer-smoke']:
    checks[name + ':exit0'] = (worktree / '.pi' / (name + '.exit')).read_text().strip() == '0'
full = (worktree / '.pi/full-test-isolated.log').read_text()
checks['full-suite-341-no-skips'] = all(re.search(r'^# ' + key + ' ' + str(value) + r'$', full, re.M) for key, value in {'tests':341, 'pass':341, 'fail':0, 'cancelled':0, 'skipped':0}.items())
checks['intentional-red-status-mismatch'] = '200 !== 413' in (worktree / '.pi/red-initialization.log').read_text()
review = (worktree / '.pi/independent-review.txt').read_text()
checks['independent-review-completed-approve'] = (worktree / '.pi/review.exit').read_text().strip() == '0' and review.startswith('**APPROVE**')
prod = json.loads((worktree / '.pi/prod-audit.json').read_text())['metadata']['vulnerabilities']
checks['production-audit-qualified-not-zero-all-advisories'] = prod['high'] == 0 and prod['critical'] == 0 and prod['moderate'] == 4
smoke = json.loads((worktree / '.pi/consumer-smoke.log').read_text())
checks['installed-consumer-old-zod-and-local-guard'] = smoke['sdkVersion'] == '1.32.2' and smoke['zodVersion'] == '4.6.5' and smoke['structuralRejection'] == 413 and smoke['blockedHandlerCalls'] == 0 and smoke['normalCall'] == 'installed-ok'
integration_path = root / 'plans/execution/010/integration.json'
integration = json.loads(integration_path.read_text()) if integration_path.exists() else {}
if integration.get('state') == 'applied_verified':
    checks['original-checkout-matches-authorized-integration'] = all(
        sha(root / f) == digest for f, digest in integration['expectedHashes'].items()
    )
else:
    checks['original-tracked-checkout-unchanged'] = subprocess.run(['git', 'diff', '--quiet', 'HEAD'], cwd=root, check=False).returncode == 0
checks['executor-staging-empty'] = subprocess.run(['git', 'diff', '--cached', '--quiet'], cwd=worktree, check=False).returncode == 0
checks['executor-diff-clean'] = subprocess.run(['git', 'diff', '--check'], cwd=worktree, check=False).returncode == 0
for name in ['plans/README.md', 'plans/010-bound-mcp-validation-and-refresh-vulnerable-dependencies.md', 'plans/evidence/010-input-budget-dependencies-review.md']:
    path = root / name
    content = path.read_text()
    checks[name + ':fences'] = sum(line.startswith('```') for line in content.splitlines()) % 2 == 0
    checks[name + ':local-links'] = all(link.startswith(('http:', 'https:', '#')) or (path.parent / link.split('#')[0]).exists() for link in re.findall(r'\]\(([^)]+)\)', content))
result = {'checks': checks, 'roundtripCopy': str(roundtrip), 'patchSha256': sha(patch), 'softwareGate': 'recorded receipts validated; not rerun by this script'}
(root / 'plans/execution/010/implementation-validation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
if not all(checks.values()):
    raise SystemExit('Artifact validation failed: ' + ', '.join(k for k, ok in checks.items() if not ok))
print(f'PASS: {len(checks)} implementation artifact/scope/receipt checks')
