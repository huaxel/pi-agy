from pathlib import Path
import subprocess,os,signal,json
f=Path(__file__).resolve().parent;m=json.loads((f/'worker.json').read_text());w=Path(m['worktree'])
args=['codex','--ask-for-approval','never','exec','--sandbox','read-only','--config','mcp_servers={}','--config','model_reasoning_effort="medium"','--json','--output-last-message',str(f/'final-review.md'),'-']
with (f/'final-review-events.jsonl').open('w') as out,(f/'final-review-stderr.log').open('w') as err:
 p=subprocess.Popen(args,cwd=w,stdin=subprocess.PIPE,stdout=out,stderr=err,text=True,start_new_session=True)
 (f/'final-review-child.json').write_text(json.dumps({'pid':p.pid,'name':'pi-011-final-review'}))
 try:p.communicate((f/'final-review-prompt.txt').read_text(),timeout=180)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 (f/'final-review.exit').write_text(str(p.returncode)+'\n')
