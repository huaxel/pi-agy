"""Validate read-only assessment evidence, not unperformed candidate qualification."""
from pathlib import Path
import hashlib
import json
import os
import re

root = Path(__file__).resolve().parents[3]
record = json.loads((root / 'plans/execution/011/research.json').read_text())
integration = json.loads((root / 'plans/execution/010/integration.json').read_text())
plan = root / 'plans/011-qualify-patched-pi-development-host.md'
text = plan.read_text()
checks = {}
checks['all-74-integrated-source-files-preserved'] = all(hashlib.sha256((root / name).read_bytes()).hexdigest() == value for name, value in record['sourceBaseline'].items())
checks['reused-audit-lock-identity'] = hashlib.sha256((root / 'package-lock.json').read_bytes()).hexdigest() == record['lockSha256']
primary = json.loads((root / 'plans/execution/011/primary-advisories.json').read_text())
checks['eleven-primary-records'] = len(primary) == 11 and all(row.get('id') and row.get('vulnerabilities') for row in primary)
checks['all-primary-advisories-discussed'] = all(row['id'] in text for row in primary)
checks['no-advisory-exploit-descriptions-retained'] = all('description' not in row for row in primary)
related = json.loads((root / 'plans/execution/011/related-minimatch-advisory.json').read_text())
checks['related-minimatch-disposition-present'] = related['id'] in text
legacy = root / 'node_modules/@earendil-works/pi-coding-agent'
checks['legacy-parent-exact-undici-pin'] = json.loads((legacy / 'package.json').read_text())['dependencies']['undici'] == '8.10.2'
checks['legacy-nested-versions-confirmed'] = all(json.loads((legacy / 'node_modules' / name / 'package.json').read_text())['version'] == version for name, version in {'undici':'8.10.2', 'minimatch':'10.2.6', 'brace-expansion':'5.0.9'}.items())
old_bundle = (legacy / 'dist/bundle/chunks/chunk-OJP47DM6.js').read_text()
checks['old-bundle-embeds-undici'] = 'node_modules/undici/lib/core/symbols.js' in old_bundle
checks['old-bundle-has-recursive-brace-parser'] = 'parseCommaParts(post)' in old_bundle
host_root = Path('/Users/juanbenjumea/dotfiles/pi/agent/install/releases/1.5.2/node_modules')
host = host_root / '@earendil-works/pi-coding-agent'
checks['inspected-host-actual-fixed-packages'] = all(json.loads((host_root / name / 'package.json').read_text())['version'] == version for name, version in {'undici':'8.12.3', 'minimatch':'11.0.3', 'brace-expansion':'5.0.12'}.items())
new_bundle = (host / 'dist/bundle/chunks/chunk-VEJDBY3O.js').read_text()
checks['inspected-new-bundle-brace-loop'] = 'function parseCommaParts(str2){let parts=[],carry="";for(;;)' in new_bundle and 'parseCommaParts(post)' not in new_bundle
checks['bundle-source-map-gap-confirmed'] = not list((legacy / 'dist/bundle').rglob('*.map')) and not list((host / 'dist/bundle').rglob('*.map'))
checks['install-is-not-authorized'] = 'Execution:** NOT AUTHORIZED' in text and 'major-version qualification' in text
checks['qualification-not-claimed-as-passed'] = 'no candidate installation/typecheck/test run' in text and 'not independently attested' in text
checks['focused-test-paths-exist'] = all((root / name).exists() for name in ['tests/provider.test.ts','tests/provider-driver.test.ts','tests/provider-mcp.test.ts','tests/bridge-input-budget.test.ts','tests/render.test.ts'])
checks['external-artifact-root-and-manifest-explicit'] = 'ARTIFACT_ROOT=/Users/juanbenjumea/projects/pi-extensions/pi-agy' in text and 'plans/execution/010/integration.json' in text
checks['all-seven-prerequisite-patches-explicit-and-present'] = all(name in text and (root / 'plans/patches' / name).exists() for name in ['002-process-tree.patch','003-tool-catalog.patch','004-bridge-sessions.patch','009-timing-tests.patch','005-terminal-response.patch','006-cancelled-resume.patch','010-input-budget-dependencies.patch'])
checks['guard-failures-explicit-even-in-conditional'] = 'cd "$WT" || return 1' in text and 'test "$(git rev-parse --show-toplevel)" = "$WT" || return 1' in text
controls = json.loads((root / 'plans/execution/011/guard-control-checks.json').read_text())
for name, passed in controls.items():
    checks['guard-control:' + name] = passed
checks['setup-js-static-syntax'] = (root / 'plans/execution/011/setup-js-syntax.exit').read_text().strip() == '0'
checks['setup-shell-static-syntax'] = (root / 'plans/execution/011/setup-shell-syntax.exit').read_text().strip() == '0'
checks['independent-plan-review-approved'] = (root / 'plans/execution/011/review.exit').read_text().strip() == '0' and (root / 'plans/execution/011/independent-review.md').read_text().startswith('**APPROVE**')
for name in ['## Proposed future scope','## Steps','## Test plan and done criteria','## STOP conditions and maintenance']:
    checks[name] = name in text
for name in ['plans/README.md', 'plans/011-qualify-patched-pi-development-host.md']:
    path = root / name
    content = path.read_text()
    checks[name + ':fences'] = sum(line.startswith('```') for line in content.splitlines()) % 2 == 0
    checks[name + ':local-links'] = all(link.startswith(('https:', 'http:', '#')) or (path.parent / link.split('#')[0]).exists() for link in re.findall(r'\]\(([^)]+)\)', content))
# Repeat the earlier metadata-only snapshot to establish that this assessment
# did not replace dependencies; never inspect dependency file contents here.
hash_state = hashlib.sha256()
count = 0
for directory, dirs, files in os.walk(root / 'node_modules', followlinks=False):
    for name in sorted(dirs + files):
        path = Path(directory) / name
        stat = path.lstat()
        value = [str(path.relative_to(root / 'node_modules')), stat.st_mode, stat.st_size, stat.st_mtime_ns, os.readlink(path) if path.is_symlink() else None]
        hash_state.update(json.dumps(value, separators=(',', ':')).encode())
        count += 1
checks['existing-dependencies-preserved'] = {'sha256':hash_state.hexdigest(), 'entries':count} == integration['dependencyFingerprintBefore']
result = {'checks':checks, 'candidateQualification':'not performed or authorized', 'softwareGate':'existing341 results reused; not rerun', 'planSha256':hashlib.sha256(plan.read_bytes()).hexdigest()}
(root / 'plans/execution/011/validation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
if not all(checks.values()):
    raise SystemExit('Assessment validation failed: ' + ', '.join(key for key, ok in checks.items() if not ok))
print(f'PASS: {len(checks)} assessment completeness/preservation checks')
