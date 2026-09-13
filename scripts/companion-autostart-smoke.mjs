import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sendCompanion } from '../companion-bridge.mjs';
const fixture=await mkdtemp('/tmp/taskplan-autostart-'), socket=join(fixture,'control.sock');
const root=new URL('../',import.meta.url).pathname, clients=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function eventually(predicate) {
  const end=Date.now()+10000;
  while(Date.now()<end) { try { const result=await predicate(); if(result)return result; } catch {} await wait(40); }
  throw new Error('Observable condition timed out');
}
async function state() { return (await sendCompanion(socket,{action:'status'})).state; }
async function connect() {
  const client=new Client({name:'autostart-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'server.mjs')],cwd:root,
    env:{...process.env,CODEX_HOME:fixture,TASK_PLAN_DB:join(fixture,'plans.sqlite'),TASK_PLAN_COMPANION_SOCKET:socket,
      TASK_PLAN_COMPANION_AUTOSTART:'1',TASK_PLAN_COMPANION_BINARY:process.env.COMPANION_BINARY,PLAN_COMPANION_HOST:'local.hidden.test'}}));
  clients.push(client);return client;
}
async function call(c,name,args) { const r=await c.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent; }
async function quit() {
  await sendCompanion(socket,{action:'quit'});
  await eventually(async()=>{try{await state();return false;}catch{return true;}});
}
const checks=[];
try {
  const a=await connect(), b=await connect();
  await assert.rejects(()=>state());checks.push('MCP startup alone does not launch app');
  const plans=await Promise.all([a,b].map((c,i)=>call(c,'create_task_plan',{title:`Auto ${i}`,steps:['One','Two']})));
  const ready=await eventually(async()=>{const s=await state();return s.planCount===2&&s;});
  assert.ok(ready.pid); checks.push('concurrent creations automatically start one socket owner and deliver both plans');
  await wait(300);assert.equal((await state()).pid,ready.pid);
  const id=plans[0].plan_id;
  await call(a,'update_task_plan_step',{plan_id:id,step_id:'step-1',status:'completed'});
  assert.equal((await state()).pid,ready.pid);checks.push('existing app reused');
  await quit();
  await call(a,'update_task_plan_step',{plan_id:id,step_id:'step-2',status:'completed'});
  await wait(800); await assert.rejects(()=>state());checks.push('completion and retry do not reopen explicitly quit app');
  const fresh=await call(b,'create_task_plan',{title:'New after quit',steps:['Prepare','Check']});
  const restarted=await eventually(async()=>{const s=await state();return s.selected===fresh.plan_id&&s;});
  assert.notEqual(restarted.pid,ready.pid);checks.push('next new plan launches app again and selects itself');
  const persisted=JSON.parse(await readFile(join(fixture,'state.json'),'utf8'));
  await eventually(async()=>JSON.parse(await readFile(join(fixture,'state.json'),'utf8')).plans.find(p=>p.id===id)?.status==='completed');
  assert.equal(persisted.selected,fresh.plan_id);checks.push('pending background completion cannot steal new plan selection');
  await writeFile(join(fixture,'report.json'),JSON.stringify({passed:checks.length,checks,fixture},null,2));
  console.log(JSON.stringify({passed:checks.length,checks,fixture},null,2));
} finally { await Promise.all(clients.map(c=>c.close()));try{await quit();}catch{} }
