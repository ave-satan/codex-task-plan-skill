import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sendCompanion } from '../companion-bridge.mjs';

const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const fixture = await mkdtemp('/tmp/taskplan-switcher-');
const socket = join(fixture, 'control.sock');
const app = spawn(binary, [], {env:{...process.env,
  PLAN_COMPANION_DATA:fixture, PLAN_COMPANION_SOCKET:socket,
  PLAN_COMPANION_HOST:'local.hidden.test', PLAN_COMPANION_TEST_DISABLE_HOST_ATTACHMENT:'1'},
  stdio:['ignore','pipe','pipe']});
app.stderr.on('data', data => process.stderr.write(data));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let initial;
  for (let attempt=0; attempt<100; attempt++) {
    try { initial = (await sendCompanion(socket,{action:'status'})).state; break; }
    catch { await delay(25); }
  }
  assert.ok(initial, 'companion did not start');
  await sendCompanion(socket,{action:'set_frame',x:initial.window.x,y:initial.window.y,
    width:280,height:360});
  for (let i=0; i<12; i++) {
    await sendCompanion(socket,{action:'upsert',plan:{id:`plan-${i}`,title:`Plan ${i}`,
      revision:1,status:'active',steps:[{id:'step-1',title:'Ready',status:'pending'}]}});
  }
  let state=(await sendCompanion(socket,{action:'test_switcher_page',name:'open'})).state;
  await delay(250);
  await sendCompanion(socket,{action:'snapshot',name:'switcher-open'});
  assert.equal(state.planSwitcherCapacity,7);
  assert.equal(state.planSwitcherSlotCount,7);
  const otherIDs=new Set(state.plans.map(plan=>plan.id).filter(id=>id!==state.selected));
  const reachable=new Set(state.visibleOtherPlanIDs);
  for(let i=0; i<3 && reachable.size<otherIDs.size; i++) {
    state=(await sendCompanion(socket,{action:'test_switcher_page',name:'next'})).state;
    assert.equal(state.planSwitcherSlotCount,7,'tray must not jump under the pointer between pages');
    for(const id of state.visibleOtherPlanIDs) reachable.add(id);
  }
  assert.deepEqual(reachable,otherIDs,'every plan must be reachable at minimum width');
  for(let i=0; i<6; i++) await sendCompanion(socket,{action:'remove',id:`plan-${i}`});
  state=(await sendCompanion(socket,{action:'status'})).state;
  assert.deepEqual(new Set(state.visibleOtherPlanIDs),
    new Set(state.plans.map(plan=>plan.id).filter(id=>id!==state.selected)),
    'shrinking below one page must restore every remaining alternative');
  assert.equal(state.planSwitcherSlotCount,5);
  console.log(`Switcher smoke passed: 12 plans remain reachable in a 280pt panel. Fixture: ${fixture}`);
} finally {
  if(app.exitCode===null) {
    const exited=once(app,'exit');
    try { await sendCompanion(socket,{action:'quit'}); await exited; }
    catch { app.kill('SIGKILL'); }
  }
}
