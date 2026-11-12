import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { registerAgyCommand, parseAgyCommandArgs } from "../extensions/commands.js";
import { buildAgyArgs } from "../extensions/lib/cli.js";
import { isAgyModelId, parseAgyModelIds, parseProviderCatalog, validateAgyModelId } from "../extensions/lib/provider-models.js";
import { createAgyStreamSimple } from "../extensions/lib/provider.js";
import { storedModelSelection } from "../extensions/lib/model-selection.js";
import { resetPreflightCache } from "../extensions/lib/preflight.js";

const roster = ["sonnet", "argon", "claude-sonnet-5-5", "claude-opus-5-5-thinking", "unknown.future", "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"];
async function harness(fn: (h: any) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agy-command-models-"));
  const oldPath = process.env.PATH, oldAgent = process.env.PI_CODING_AGENT_DIR;
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ roster: roster.join("\n") }));
  await writeFile(path.join(dir, "agy"), `#!${process.execPath}
const fs = require('node:fs'), p = require('node:path');
const dir = __dirname, args = process.argv.slice(2);
fs.appendFileSync(p.join(dir, 'calls.jsonl'), JSON.stringify(args)+'\\n');
const state = JSON.parse(fs.readFileSync(p.join(dir,'state.json'),'utf8'));
if(args[0] === 'models' && state.hold) { fs.writeFileSync(p.join(dir,'waiting'),''); const timer = setInterval(() => { if(fs.existsSync(p.join(dir,'release'))) { clearInterval(timer); console.log(state.roster); } },5); }
else if(args[0] === 'models') { if(state.error) { console.error(state.error); process.exit(1); } console.log(state.roster); }
else if(args[0] === '--version') console.log('agy 1.2.0');
else if(args.includes('/usage')) console.log(JSON.stringify(state.usage || {}));
else console.log(JSON.stringify({event:'result', conversation_id:'conv-exact', result:{response:'done',status:'SUCCESS'}}));
`);
  await chmod(path.join(dir, "agy"), 0o755);
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  process.env.PI_CODING_AGENT_DIR = path.join(dir, "agent");
  let command: RegisteredCommand;
  const receipts: any[] = [], notices: string[] = [], confirms: string[] = [], statuses: string[] = [];
  let options: string[] = [], title = "", chosen: string | undefined;
  registerAgyCommand({ registerCommand: (_: string, c: RegisteredCommand) => { command = c; }, appendEntry: (_: string, r: unknown) => receipts.push(r) } as unknown as ExtensionAPI);
  const ctx = { mode: "tui", cwd: dir, waitForIdle: async () => {}, sessionManager: { buildContextEntries: () => [] }, ui: {
    select: async (t: string, opts: string[]) => { title = t; options = opts; return chosen ? opts.find(o => o === chosen || o.startsWith(chosen + " — ")) : undefined; },
    editor: async () => "follow up", confirm: async (_: string, body: string) => { confirms.push(body); return true; },
    notify: (n: string) => notices.push(n), setStatus: (_: string, s?: string) => { if(s) statuses.push(s); },
  }} as unknown as ExtensionCommandContext;
  const h = { dir, receipts, notices, confirms, statuses, ctx,
    run: async (args = "plan", pick?: string, overrides = {}) => { chosen = pick; await command!.handler(args, { ...ctx, ...overrides }); return { options, title }; },
    complete: async (prefix: string) => command!.getArgumentCompletions?.(prefix),
    state: async (state: unknown) => { resetPreflightCache(); await writeFile(path.join(dir,"state.json"), JSON.stringify(state)); },
    calls: async () => (await readFile(path.join(dir,"calls.jsonl"),"utf8")).trim().split("\n").map(s => JSON.parse(s)),
  };
  try { await fn(h); } finally { process.env.PATH = oldPath; if(oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent; resetPreflightCache(); }
}

it("registered /agy offers full raw roster, refreshing and reporting failure truthfully", async () => harness(async h => {
  let view = await h.run();
  for(const id of roster) assert.ok(view.options.includes(id), `missing ${id}: ${view.options}`);
  assert.deepEqual(await h.calls(), [["models"]]);
  assert.ok((await h.complete("plan model=arg")).some((c: any) => c.value === "plan model=argon"));
  await h.state({roster: "new.future\nargon"});
  view = await h.run();
  assert.ok(view.options.includes("new.future"));
  assert.ok(!view.options.includes("claude-sonnet-5-5"));
  await h.state({error: "authentication failed; login required"});
  view = await h.run();
  assert.match(h.notices.join("\n"), /authentication failed/);
  assert.match(view.title, /last successful/i);
  assert.ok(view.options.includes("new.future"));
  for(const raw of ["", "Models:\n--bad\n!!!"]) {
    await h.state({roster: raw});
    view = await h.run();
    assert.match(view.title, /last successful/i);
    assert.ok(view.options.includes("new.future"));
  }
  await h.state({roster: "recovered"});
  view = await h.run();
  assert.ok(view.options.includes("recovered"));
  assert.ok(!view.options.includes("new.future"));
}));

it("first discovery failure visibly offers alias fallback and retries", async () => harness(async h => {
  await h.state({error:"login required"});
  const view = await h.run();
  assert.match(view.title, /alias fallback/i);
  assert.match(h.notices.join("\n"), /login required/);
  assert.ok(view.options.some((o: string) => o.startsWith("flash — ")));
  await h.state({roster: "argon"});
  assert.ok((await h.run()).options.includes("argon"));
}));

for (const id of roster) it(`picker passes ${id} unchanged through confirmation, argv, receipt and persistence`, async () => harness(async h => {
  await h.run("accept-edits task text", id);
  const inference = (await h.calls()).find((a: string[]) => a.includes("--model"));
  assert.ok(inference, h.notices.join("\n"));
  assert.equal(inference[inference.indexOf("--model")+1], id);
  assert.ok(!inference.includes("--effort"));
  assert.ok(h.confirms.some((s: string) => s.includes(id)));
  assert.ok(h.statuses.some((s: string) => s.includes(id)));
  assert.equal(h.receipts[0].details.model, id);
  const store = JSON.parse(await readFile(path.join(h.dir,"agent/agy-sessions.json"),"utf8"));
  assert.equal(store[h.dir].last_model, id);
  assert.equal(store[h.dir].last_raw_model_id, id);
  assert.equal(store[h.dir].history[0].model, id);
  assert.equal(store[h.dir].history[0].raw_model_id, id);
  await h.run("plan continue more");
  let calls = (await h.calls()).filter((a: string[]) => a.includes("--model"));
  assert.equal(calls.at(-1)[1], id);
  // Select the recorded session, then a plan mode, without changing its ID.
  h.ctx.ui.select = async (title: string, opts: string[]) => title === "agy mode" ? opts.find(o => o.startsWith("plan —")) : opts[0];
  await h.run("sessions");
  calls = (await h.calls()).filter((a: string[]) => a.includes("--model"));
  assert.equal(calls.at(-1)[1], id);
  assert.ok(calls.at(-1).includes("conv-exact"));
}));

it("explicit model= preserves IDs and prompt grammar; rejects unsafe IDs and conflicts", () => {
  assert.deepEqual(parseAgyCommandArgs("plan model=unknown.future examine\nthis"), {mode:"plan", model_id:"unknown.future", prompt:"examine\nthis"});
  for(const input of ["model=--help task", "model= task", "model=argon\u0000 task", "model=argon model=other task", "flash model=argon task"]) assert.ok(parseAgyCommandArgs(input).error, input);
  assert.equal(parseAgyCommandArgs("argon explain this").prompt, "argon explain this");
  assert.equal(parseAgyCommandArgs("review model=argon later").prompt, "review model=argon later");
  assert.equal(parseAgyCommandArgs("sonnet review").model, "sonnet");
});

it("explicit exact ID cannot be substituted on exhausted quota", async () => harness(async h => {
  await h.state({roster:roster.join("\n"),usage:{models:[{model:"claude-sonnet-5-5", remaining_fraction:0},{model:"gemini-3.8-flash-medium",remaining_fraction:1}]}});
  await h.run("plan model=claude-sonnet-5-5 inspect");
  assert.match(h.notices.join("\n"), /quota exhausted for claude-sonnet-5-5/);
  assert.ok(!(await h.calls()).some((a: string[]) => a.includes("--model")));
  assert.equal(h.receipts.length,0);
}));


it("shared raw parser and exact selector reject unsafe token domains", () => {
  for (const id of ["argon", "unknown.future", "a.b-c", "claude-sonnet-5-5", "gemini-3.8-flash-low"]) {
    assert.equal(validateAgyModelId(id), id);
    const args = buildAgyArgs({prompt:"task",model_id:validateAgyModelId(id),dir:"/tmp",timeout_ms:1000});
    assert.equal(args[1],id);
  }
  for (const id of ["", "--model", "-p", " argon", "argon ", "argon\n", "argon\r", "argon\t", "claude-sonnet-5-5\n", "claude-sonnet-5-5\r", "claude-sonnet-5-5\t", "claude-sonnet-5-5 ", "claude-sonnet-5-5\u0000", "a/b", "a\u0000", "Models:", "error", "auth"]) {
    assert.equal(isAgyModelId(id),false,JSON.stringify(id));
    assert.throws(() => validateAgyModelId(id));
  }
  assert.deepEqual(parseAgyModelIds("Models:\nargon  Argon\nunknown.future Future\nclaude-sonnet-5-5\tSonnet label\nargon\n--bad\n!!!"),["argon","unknown.future","claude-sonnet-5-5"]);
  assert.throws(() => buildAgyArgs({prompt:"task",model_id:validateAgyModelId("argon"), model:"sonnet",dir:"/tmp",timeout_ms:1000} as any), /cannot be combined/);
});


async function waitForFile(file: string) {
  const deadline = Date.now() + 3000;
  while (true) {
    try { await readFile(file); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() > deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}

it("late discovery cannot replace a newer roster", async () => harness(async h => {
  await h.state({roster:"old.future",hold:true});
  const old = h.run();
  await waitForFile(path.join(h.dir,"waiting"));
  await h.state({roster:"new.future"});
  await h.run();
  await writeFile(path.join(h.dir,"release"),"");
  await old;
  assert.deepEqual((await h.complete("model=")).map((c: any) => c.value),["model=new.future"]);
}));

it("cancelled discovery retains last successful roster", async () => harness(async h => {
  await h.run();
  await h.state({roster:"cancelled.future",hold:true});
  const controller = new AbortController();
  const pending = h.run("plan",undefined,{signal:controller.signal});
  await waitForFile(path.join(h.dir,"waiting"));
  controller.abort();
  await pending;
  const values = (await h.complete("model=")).map((c: any) => c.value);
  assert.ok(values.includes("model=argon"));
  assert.ok(!values.includes("model=cancelled.future"));
}));

it("failure in another cwd never receives the first cwd roster", async () => harness(async h => {
  await h.run();
  await h.state({error:"login required"});
  const other = await mkdtemp(path.join(os.tmpdir(),"agy-model-other-"));
  const view = await h.run("plan",undefined,{cwd:other});
  assert.match(view.title,/alias fallback/i);
  assert.ok(!view.options.includes("argon"));
  assert.deepEqual(await h.complete("model="),[]);
}));

it("direct exact selection and bare aliases preserve prompt and current alias resolution", async () => harness(async h => {
  const view = await h.run();
  assert.ok(view.options.some((o: string) => o.startsWith("sonnet — alias shortcut (claude-sonnet-5-5")));
  await h.run("plan sonnet inspect this");
  await h.run("plan model=unknown.future argon is prompt text");
  const calls = (await h.calls()).filter((a: string[]) => a.includes("--model"));
  assert.equal(calls[0][1],"claude-sonnet-5-5");
  assert.equal(h.receipts[0].details.model,"sonnet");
  assert.equal(calls[1][1],"unknown.future");
  assert.match(calls[1][calls[1].indexOf("-p")+1],/argon is prompt text/);
}));

it("write permission rejection and picker cancellation never execute", async () => harness(async h => {
  h.ctx.ui.confirm = async () => false;
  await h.run("accept-edits model=argon task");
  assert.equal(h.receipts.length,0);
  await h.run();
  assert.ok(!(await h.calls()).some((a: string[]) => a.includes("--model")));
}));

it("legacy model restoration never guesses normalized provider IDs", () => {
  assert.deepEqual(storedModelSelection("sonnet"),{model:"sonnet"});
  assert.deepEqual(storedModelSelection("sonnet","sonnet"),{model_id:"sonnet"});
  assert.deepEqual(storedModelSelection("argon"),{model_id:"argon"});
  assert.deepEqual(storedModelSelection("unknown.future"),{model_id:"unknown.future"});
  for (const id of ["gemini-3-8-flash", "claude-sonnet-5-5", "--help", "bad id"]) assert.equal(storedModelSelection(id),undefined);
  assert.equal(storedModelSelection("sonnet","--help"),undefined);
});

for (const raw of ["unknown.future", "gemini-3.8-flash-medium"]) it(`provider persistence keeps native resume key and supplies exact /agy resume ID: ${raw}`, async () => harness(async h => {
  const entries = parseProviderCatalog(roster.join("\n"));
  const entry = entries.find(e => e.full === raw)!;
  const modelId = raw.startsWith("gemini") ? entries.find(e => e.full === "gemini-3.8-flash")!.id : entry.id;
  const seen: any[] = [];
  async function providerTurn(priorAssistant = false) {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const events: any[] = [];
    const stream = createAgyStreamSimple({createStream: () => ({push: e => events.push(e),end: () => finish()}),getSystemPrompt: () => ""}, {
      dir:h.dir,entries,runner:{run:async request => { seen.push(request); return {kind:"done", result:{text:"ok",truncated:false,conversationId:"provider-conv",activity:[]}}; },resume:async () => {throw new Error("unexpected park");},cancel:() => {}},
    });
    stream({id:modelId},[...(priorAssistant ? [{role:"assistant" as const,content:"prior"}] : []),{role:"user",content:"task"}],{reasoning:"medium"});
    await done;
    assert.ok(!events.some(e => e.type === "error"),JSON.stringify(events));
  }
  await providerTurn();
  const store = JSON.parse(await readFile(path.join(h.dir,"agent/agy-sessions.json"),"utf8"));
  assert.equal(store[h.dir].last_model,modelId);
  assert.equal(store[h.dir].last_raw_model_id,raw);
  await providerTurn(true); // New provider instance must still resume via model.id.
  assert.equal(seen[1].resumeConversationId,"provider-conv");
  h.ctx.ui.select = async (title: string, opts: string[]) => title === "agy mode" ? opts.find(o => o.startsWith("plan —")) : opts[0];
  await h.run("sessions");
  const calls = (await h.calls()).filter((a: string[]) => a.includes("--model"));
  assert.equal(calls.at(-1)[1],raw);
  assert.ok(calls.at(-1).includes("provider-conv"));
}));

it("parked provider persistence retains its original raw selector across reasoning and catalog changes", async () => harness(async h => {
  const entries = parseProviderCatalog("gemini-3.8-flash-low\ngemini-3.8-flash-high");
  const events: any[] = [];
  let finish!: () => void;
  let done: Promise<void>;
  let resumes = 0;
  const stream = createAgyStreamSimple({createStream: () => {
    done = new Promise<void>(resolve => {finish = resolve;});
    return {push:e => events.push(e),end:() => finish()};
  },getSystemPrompt:() => ""}, {
    dir:h.dir,entries,runner:{
      run:async request => { assert.equal(request.fullModel,"gemini-3.8-flash"); assert.equal(request.effort,"low"); return {kind:"parked",park:{callId:"park-original",toolName:"read",args:{}}}; },
      resume:async () => ++resumes === 1 ? {kind:"parked",park:{callId:"park-again",toolName:"read",args:{}}} : {kind:"done",result:{text:"done",truncated:false,conversationId:"parked-conv",activity:[]}},
      cancel:() => {},
    },
  });
  const messages: any[] = [{role:"user",content:"inspect"}];
  stream({id:"gemini-3-8-flash"},messages,{reasoning:"low"});
  await done!;
  // The same Pi ID can resolve to a different raw target after refresh.
  entries[0].full = "gemini-9.9-flash";
  for (const reasoning of ["high", "medium"] as const) {
    const call = events.filter(e => e.type === "toolcall_end").at(-1).toolCall;
    messages.push({role:"assistant",content:[call]},{role:"toolResult",toolCallId:call.id,toolName:"read",content:"result"});
    stream({id:"gemini-3-8-flash"},messages,{reasoning});
    await done!;
  }
  const store = JSON.parse(await readFile(path.join(h.dir,"agent/agy-sessions.json"),"utf8"));
  assert.equal(store[h.dir].last_model,"gemini-3-8-flash");
  assert.equal(store[h.dir].last_raw_model_id,"gemini-3.8-flash-low");
  assert.equal(store[h.dir].history[0].raw_model_id,"gemini-3.8-flash-low");
}));


it("native exact-ID completion preserves the entire argument prefix and following prompt", async () => harness(async h => {
  await h.run(); // Populate last-good roster using only the fake discovery CLI.
  const provider = new CombinedAutocompleteProvider([
    {name:"agy", getArgumentCompletions: prefix => h.complete(prefix)},
  ], h.dir);
  const callsBefore = await h.calls();
  for (const leading of ["", "plan ", "plan continue timeout=90s context=recent ", "plan  continue\ttimeout=90s context=recent  "]) {
    for (const [partial, id] of [["arg", "argon"], ["unknown.f", "unknown.future"], ["", "argon"]]) {
      const argumentPrefix = `${leading}model=${partial}`;
      const beforeCursor = `/agy ${argumentPrefix}`;
      const line = `${beforeCursor} inspect this`;
      const suggestions = await provider.getSuggestions([line],0,beforeCursor.length,{signal:new AbortController().signal});
      assert.ok(suggestions);
      assert.equal(suggestions.prefix,argumentPrefix);
      const item = suggestions.items.find(candidate => candidate.label.startsWith(`${id} (`));
      assert.ok(item);
      assert.equal(item.value,`${leading}model=${id}`);
      const applied = provider.applyCompletion([line],0,beforeCursor.length,item,suggestions.prefix);
      assert.deepEqual(applied.lines,[`/agy ${leading}model=${id} inspect this`]);
      assert.equal(applied.cursorCol,`/agy ${leading}model=${id}`.length);
      const parsed = parseAgyCommandArgs(applied.lines[0].slice("/agy ".length));
      assert.equal(parsed.model_id,id);
      assert.equal(parsed.prompt,"inspect this");
      assert.equal(parsed.error,undefined);
      assert.equal(parsed.mode,leading ? "plan" : undefined);
      assert.equal(parsed.continue,leading.includes("continue") ? true : undefined);
      assert.equal(parsed.timeout_ms,leading.includes("timeout=") ? 90_000 : undefined);
      assert.equal(parsed.context,leading.includes("context=") ? "recent" : undefined);
    }
  }
  assert.deepEqual(await h.calls(),callsBefore); // Completion must remain cache-only.
}));
