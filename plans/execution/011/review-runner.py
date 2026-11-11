from pathlib import Path
import subprocess,os,signal,json
root=Path(__file__).resolve().parents[3]
f=Path(__file__).resolve().parent
args=['codex','--ask-for-approval','never','exec','--sandbox','read-only','--config','mcp_servers={}','--config','model_reasoning_effort="medium"','--json','--output-last-message',str(f/'independent-review.md'),'resume','01a1cba0-9805-7d02-af0d-230ecc41f485','-']
with (f/'review-events.jsonl').open('w') as out,(f/'review-stderr.log').open('w') as err:
 p=subprocess.Popen(args,cwd=root,stdin=subprocess.PIPE,stdout=out,stderr=err,text=True,start_new_session=True)
 (f/'review-child.json').write_text(json.dumps({'pid':p.pid,'name':'host-peer-plan-review','mode':'native Codex read-only'}))
 try:p.communicate((f/'review-prompt.txt').read_text(),timeout=180)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 (f/'review.exit').write_text(str(p.returncode)+'\n')
