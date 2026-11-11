"""Read-only evidence/source QA; writes only the planning validation result."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

root = Path(__file__).resolve().parents[3]
meta = json.loads((root / 'plans/execution/010/research.json').read_text())
worktree = Path(meta['worktree'])
evidence = worktree / '.pi/security-010'
checks = {}
for filename, expected in meta['manifestHashes'].items():
    for tree, label in [(root, 'original'), (worktree, 'accepted')]:
        checks[f'{label}:{filename}:unchanged'] = hashlib.sha256((tree / filename).read_bytes()).hexdigest() == expected

audit = json.loads((evidence / 'audit.json').read_text())
checks['fresh-audit-8-package-entries'] = audit['metadata']['vulnerabilities'] == {
    'info': 0, 'low': 0, 'moderate': 5, 'high': 3, 'critical': 0, 'total': 8,
}
sdk = json.loads((evidence / 'modelcontextprotocol_sdk1.32.2.json').read_text())
checks['registry-sdk-1.32.2'] = sdk['version'] == '1.32.2'
checks['registry-zod-range-still-permits-old-versions'] = sdk['dependencies']['zod'] == '^3.25 || ^4.0'
handler = (worktree / 'extensions/lib/provider-mcp.ts').read_text().split('async function handleBridgeRequest(', 1)[1]
seam = ['timingSafeEqual(actual, expected)', 'req.headers.host', 'await readBody(req)',
        'if (body === undefined)', 'await resolveTransport(req, body)',
        'await resolved.transport.handleRequest(req, res, body)']
positions = [handler.index(part) for part in seam]
checks['actual-auth-reader-resolver-transport-order'] = positions == sorted(positions)
patched = root / 'node_modules/@modelcontextprotocol/sdk/dist/esm'
checks['inspected-sdk-version'] = json.loads((root / 'node_modules/@modelcontextprotocol/sdk/package.json').read_text())['version'] == '1.32.2'
checks['low-level-tool-arguments-unknown-record'] = 'arguments: z.record(z.string(), z.unknown()).optional()' in (worktree / 'node_modules/@modelcontextprotocol/sdk/dist/esm/types.js').read_text()
checks['budget-option-on-high-level-only'] = (
    'maxToolInputElements' in (patched / 'server/mcp.d.ts').read_text()
    and 'maxToolInputElements' not in (patched / 'server/index.d.ts').read_text()
    and 'maxToolInputElements' not in (patched / 'shared/protocol.d.ts').read_text()
)
web = (patched / 'server/webStandardStreamableHttp.js').read_text()
checks['parsed-body-bypasses-sdk-owned-reader'] = (
    'if (options?.parsedBody !== undefined)' in web and 'rawMessage = options.parsedBody' in web
)
hashes = {}
for name in ['plans/README.md', 'plans/010-bound-mcp-validation-and-refresh-vulnerable-dependencies.md']:
    path = root / name
    content = path.read_text()
    hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    checks[name + ':balanced-fences'] = sum(line.startswith('```') for line in content.splitlines()) % 2 == 0
    links = re.findall(r'\]\(([^)]+)\)', content)
    checks[name + ':local-links'] = all(
        link.startswith(('http:', 'https:', '#')) or (path.parent / link.split('#')[0]).exists()
        for link in links
    )
    if '/010-' in name:
        for heading in ['## Scope', '## Steps', '## Done criteria', '## STOP conditions',
                        '## Planning verification and review status']:
            checks[heading] = heading in content
checks['original-tracked-tree-unchanged'] = subprocess.run(
    ['git', 'diff', '--quiet', 'HEAD', '--', '.'], cwd=root, check=False,
).returncode == 0
checks['staging-empty'] = subprocess.run(
    ['git', 'diff', '--cached', '--quiet'], cwd=root, check=False,
).returncode == 0
result = {
    'checks': checks,
    'documentSha256': hashes,
    'projectGate': 'not rerun: planning-only; no source/dependency changes',
    'independentPlanReview': 'not performed; no nested Pi process launched',
}
(root / 'plans/execution/010/validation.json').write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps(result, indent=2))
if not all(checks.values()):
    raise SystemExit('Planning QA failed; inspect individual checks')
print(f'PASS: {len(checks)} planning consistency checks; no implementation tests executed')
