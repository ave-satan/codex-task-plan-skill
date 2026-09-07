import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), 'task-plan-restart-'));
const clients=[];
const goals = new DatabaseSync(join(fixture,'goals_1.sqlite'));
goals.exec('CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT)');
const thread='00000000-0000-4000-8000-000000000009';
async function connect() {
  const client = new Client({name:'restart-smoke',version:'1'});
  const transport = new StdioClientTransport({command:process.execPath,args:[join(root,'server.mjs')],cwd:root,
    env:{...process.env,CODEX_HOME:fixture,CODEX_SQLITE_HOME:fixture,TASK_PLAN_DB:join(fixture,'plans.sqlite')}});
  await client.connect(transport); clients.push(client); return {client,transport};
}
async function call(client,name,args) {
  const result=await client.callTool({name,arguments:args});
  assert.ok(!result.isError,JSON.stringify(result)); return result;
}
try {
  const a=await connect();
  const created=await call(a.client,'create_task_plan',{title:'Persistence fixture',thread_id:thread,steps:Array.from({length:12},(_,i)=>`Step ${i+1}: verify persistent state without losing work`)});
  const id=created.structuredContent.plan_id;
  assert.ok(created.structuredContent.next_action);
  await call(a.client,'show_task_plan',{plan_id:id});
  const args={plan_id:id,step_id:'step-1',status:'in_progress',progress:42,note:'Saved checkpoint',agents:[{name:'tester',category:'testing'}]};
  const update=await call(a.client,'update_task_plan_step',args);
  assert.equal(update.structuredContent.plan,undefined);
  assert.equal(update.structuredContent.step.progress,42);
  assert.equal(update.structuredContent.next_action,null);
  goals.prepare('INSERT INTO thread_goals VALUES(?,?,?,?)').run(thread,'fixture-goal','Persistence fixture','active');
  const before=(await call(a.client,'get_task_plan',{plan_id:id})).structuredContent.plan;
  const oldBytes=JSON.stringify({structuredContent:{plan:before,next_action:null},content:update.content}).length;
  const newBytes=JSON.stringify(update).length;
  assert.ok(newBytes<oldBytes*.5,`${newBytes} vs ${oldBytes}`);
  await call(a.client,'record_task_plan_output',{plan_id:id,points:3});
  // Abrupt exit: durable acknowledgement must not depend on graceful shutdown.
  process.kill(a.transport.pid,'SIGKILL');
  await a.client.close();
  goals.prepare('UPDATE thread_goals SET objective=?').run('User renamed the same goal');
  const b=await connect(), c=await connect();
  const recovered=(await call(b.client,'get_task_plan',{plan_id:id})).structuredContent;
  assert.deepEqual(recovered.plan,before);
  assert.equal(recovered.plan.goal.state,'linked');
  assert.equal(recovered.next_action,null);
  assert.equal((await call(b.client,'record_task_plan_output',{plan_id:id,points:1})).structuredContent.should_show,true);
  // Two processes update independent steps in the same plan; neither update may disappear.
  await Promise.all([b,c].map((x,i)=>call(x.client,'update_task_plan_step',{plan_id:id,step_id:`step-${i+2}`,status:'in_progress',agents:[{name:`worker-${i}`,category:'review'}]})));
  const concurrent=(await call(b.client,'get_task_plan',{plan_id:id})).structuredContent.plan;
  assert.equal(concurrent.steps[1].status,'in_progress');assert.equal(concurrent.steps[2].status,'in_progress');
  const child=(await call(c.client,'create_task_plan',{title:'Child',steps:['A','B'],parent_plan_id:id,parent_step_id:'step-4'})).structuredContent.plan_id;
  await b.client.close();await c.client.close();
  const d=await connect();
  for(const step_id of ['step-1','step-2']) await call(d.client,'update_task_plan_step',{plan_id:child,step_id,status:'completed'});
  const parent=(await call(d.client,'get_task_plan',{plan_id:id})).structuredContent.plan;
  assert.equal(parent.steps[3].status,'completed');assert.equal(parent.steps[3].childPlans[0].id,child);
  const revision=parent.revision;
  const rejected=await d.client.callTool({name:'revise_task_plan',arguments:{plan_id:id,remove_step_ids:['step-1']}});
  assert.equal(rejected.isError,true);
  assert.equal((await call(d.client,'get_task_plan',{plan_id:id})).structuredContent.plan.revision,revision);
  await call(d.client,'cancel_task_plan',{plan_id:id});await d.client.close();
  const e=await connect();assert.equal((await call(e.client,'get_task_plan',{plan_id:id})).structuredContent.plan.status,'cancelled');
  console.log(`Restart smoke passed: SIGKILL recovery, scores, notices, two processes, subplans, rejected mutation, cancellation. Mutation reply: ${oldBytes} -> ${newBytes} chars (${Math.round(100*(1-newBytes/oldBytes))}% smaller).`);
} finally {
  await Promise.all(clients.map(c=>c.close()));
  goals.close();
  await rm(fixture,{recursive:true,force:true});
}
