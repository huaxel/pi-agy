from pathlib import Path
import subprocess,signal,os,json
f=Path(__file__).resolve().parent
m=json.loads((f/'worker.json').read_text());w=Path(m['worktree'])
settings='{'+', '.join(k+'='+json.dumps(v) for k,v in m['environment'].items())+'}'
args=['codex','--ask-for-approval','never','exec','--sandbox','workspace-write','--add-dir',m['taskRoot'],'--config','sandbox_workspace_write.network_access=true','--config','shell_environment_policy.inherit="none"','--config','shell_environment_policy.set='+settings,'--config','mcp_servers={}','--config','model_reasoning_effort="medium"','--json','--output-last-message',str(w/'.pi/executor-report.txt'),'resume','01a1cbb6-3ce6-7673-9a14-d7fad53ed76d','-']
with (f/'executor-events.jsonl').open('w') as out,(f/'executor-stderr.log').open('w') as err:
 p=subprocess.Popen(args,cwd=w,stdin=subprocess.PIPE,stdout=out,stderr=err,text=True,start_new_session=True)
 m['pid']=p.pid;(f/'worker.json').write_text(json.dumps(m,indent=2)+'\n')
 try:p.communicate((f/'executor-prompt.txt').read_text(),timeout=600)
 except subprocess.TimeoutExpired:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 (f/'executor.exit').write_text(str(p.returncode)+'\n')
