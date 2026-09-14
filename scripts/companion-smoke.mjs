import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sendCompanion } from '../companion-bridge.mjs';

const fixture = await mkdtemp('/tmp/taskplan-bridge-');
const socket = join(fixture, 'control.sock');
const binary = process.env.COMPANION_BINARY;
assert.ok(binary, 'Set COMPANION_BINARY to the built native companion');
const root = new URL('../', import.meta.url).pathname;
const dbPath = join(fixture, 'plans.sqlite');
let app; const clients = []; const checks = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function eventually(predicate) {
  const until = Date.now() + 10000;
  while (Date.now() < until) { try { const value = await predicate(); if (value) return value; } catch {} await delay(30); }
  throw new Error('Timed out waiting for observable result');
}
async function launch() {
  app = spawn(binary, [], { env: { ...process.env, PLAN_COMPANION_DATA: join(fixture, 'ui'),
    PLAN_COMPANION_SOCKET: socket, PLAN_COMPANION_HOST: 'local.hidden.test' }, stdio: ['ignore','pipe','pipe'] });
  app.stderr.on('data', data => process.stderr.write(data));
  await eventually(async () => (await sendCompanion(socket, {action:'status'})).ok);
}
async function stop() { const exited = once(app, 'exit'); await sendCompanion(socket, {action:'quit'}); await exited; }
async function connect() {
  const client = new Client({name:'companion-integration',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'server.mjs')],cwd:root,
    env:{...process.env,CODEX_HOME:fixture,TASK_PLAN_DB:dbPath,TASK_PLAN_COMPANION_SOCKET:socket}}));
  clients.push(client); return client;
}
async function call(client, name, args) {
  const value = await client.callTool({name,arguments:args});
  assert.ok(!value.isError, JSON.stringify(value)); return value.structuredContent;
}
async function saved() { return JSON.parse(await readFile(join(fixture,'ui/state.json'),'utf8')); }
async function delivered(id, revision) {
  return eventually(async () => {
    const state = await saved(); const plan = state.plans.find(p => p.id === id);
    return plan?.sourceRevision === revision && state;
  });
}
try {
  await launch(); const a = await connect(), b = await connect();
  const initialWindow=(await sendCompanion(socket,{action:'status'})).state.window;
  assert.equal(initialWindow.systemTitleVisible,false);
  assert.equal(initialWindow.activationStyle,'nonactivating-panel');
  assert.equal(initialWindow.canBecomeKey,false);
  assert.equal(initialWindow.clickKeepsVisible,true);
  assert.equal(initialWindow.resizable,true);
  assert.equal(initialWindow.movableByBackground,true);
  assert.equal(initialWindow.resizeCursorZones,8);
  assert.equal(initialWindow.resizeCursorTracking,'explicit-18pt-custom-functional-edge-single-cursor');
  assert.equal(initialWindow.resizeCoordinateMapping,'flipped-hosting-view-to-screen-edges');
  assert.equal(initialWindow.nativeResizableStyleMask,false);
  assert.equal(initialWindow.resizeImplementation,'custom-content-edge');
  assert.equal(initialWindow.fallbackResizeCursorSuppressed,false);
  assert.equal(initialWindow.closable,false);
  assert.equal(initialWindow.menuBarItemVisible,false);
  assert.equal(initialWindow.customCloseButtonVisible,false);
  assert.equal(initialWindow.pendingStepIconVisible,true);
  assert.equal(initialWindow.pendingStepIconStyle,'bouncing-ellipsis');
  assert.equal(initialWindow.questionStepStatus,'waiting_for_user');
  assert.equal(initialWindow.questionStepIconStyle,'orange-questionmark-bubble-no-background');
  assert.equal(initialWindow.questionStepAnimation,'subtle-breathe-and-lift');
  assert.equal(initialWindow.pendingStepAnimationInterval,'stable-random-3.0-5.399s');
  assert.equal(initialWindow.statusIconVerticalOffset,-4);
  assert.equal(initialWindow.pendingDotsVerticalOffset,0);
  assert.equal(initialWindow.pendingDotsBaseOpacity,0.5);
  assert.equal(initialWindow.statusIconPalette,'original-vivid');
  assert.equal(initialWindow.statusIconBackgroundVisible,false);
  assert.equal(initialWindow.indeterminateStepProgressVisible,false);
  assert.equal(initialWindow.footerVisible,false);
  assert.equal(initialWindow.progressBarStyle,'thin-blue-animated');
  assert.equal(initialWindow.progressAnimationOrigin,'leading-edge');
  assert.equal(initialWindow.prototypeBadgeVisible,false);
  assert.equal(initialWindow.mascotVisible,false);
  assert.equal(initialWindow.headerBrandVisible,false);
  assert.equal(initialWindow.headerContents,'emoji-title-counter');
  assert.equal(initialWindow.planIconMultilineAlignment,'title-block-center');
  assert.equal(initialWindow.counterAlignment,'title-baseline');
  assert.equal(initialWindow.counterStyle,'rounded-outline');
  assert.equal(initialWindow.palette,'codex-panel');
  assert.equal(initialWindow.surfaceRGB,'#222224');
  assert.equal(initialWindow.stepsSurfaceRGB,'#1F1F21');
  assert.equal(initialWindow.borderRGB,'#303032');
  assert.equal(initialWindow.windowBorderStyle,'custom-rounded-1pt');
  assert.equal(initialWindow.windowShadowVisible,false);
  assert.equal(initialWindow.contentInset,12);
  assert.equal(initialWindow.headerTopInset,12);
  assert.equal(initialWindow.iconColumnWidth,24);
  assert.equal(initialWindow.textColumnAlignment,'header-step-note');
  assert.equal(initialWindow.stepTextRGB,'#B8B8BA');
  assert.equal(initialWindow.planSelectorStyle,'hover-icon-strip');
  assert.equal(initialWindow.planSelectorControlVisible,false);
  assert.equal(initialWindow.planIconStyle,'emoji-hover-background');
  assert.equal(initialWindow.planIconGlyphSize,18);
  assert.equal(initialWindow.planEmojiPoolCount,150);
  assert.equal(initialWindow.planOverflowBadge,'+N');
  assert.equal(initialWindow.planSwitcherPlacement,'immediate-slide-from-active-icon');
  assert.equal(initialWindow.planSwitcherRevealDelay,0);
  assert.equal(initialWindow.planTooltipStyle,'detached-nonactivating-title-tooltip');
  assert.equal(initialWindow.planTooltipVisualStyle,'codex-dark-floating-card-rounded-8pt');
  assert.equal(initialWindow.planTooltipTextSize,11);
  assert.equal(initialWindow.planTooltipMaxTextWidth,220);
  assert.equal(initialWindow.planTooltipOverflow,'outside-panel-screen-clamped-word-wrapped-two-lines');
  assert.equal(initialWindow.planHoverBackdrop,'shared-rounded-tray');
  assert.equal(initialWindow.planHoverExitGrace,0.18);
  assert.equal(initialWindow.planHoverExitOrder,'tooltip-fade-icons-spring-tray-fade');
  assert.equal(initialWindow.headerDividerVisible,true);
  assert.equal(initialWindow.headerDividerHeight,0.5);
  assert.equal(initialWindow.headerDividerRGB,'#303032');
  assert.equal(initialWindow.collapsedBorder,'1pt-white-17pct');
  assert.equal(initialWindow.collapsedExpandDelay,0.7);
  assert.equal(initialWindow.collapsedDragSuppressesExpansion,true);
  assert.equal(initialWindow.hoverExpandedFrameContainsSourceIcon,true);
  assert.equal(initialWindow.collapseVisualSwap,'after-frame-animation-completes');
  assert.equal(initialWindow.hostLifecycle,'workspace-termination-observer-with-750ms-running-app-fallback');
  assert.equal(initialWindow.agentIconStyle,'illustrated-assets');
  assert.equal(initialWindow.agentPulseStyle,'subtle-opacity-contrast');
  assert.equal(initialWindow.agentIconVerticalOffset,-2);
  assert.equal(initialWindow.agentOverflow,'overlay-text-with-stronger-material-blur');
  assert.equal(initialWindow.agentStackTrigger,'title-plus-icons-overflow-always-compacts');
  assert.equal(initialWindow.agentStackMaximumWidth,128);
  assert.equal(initialWindow.agentStackStrideScale,0.42);
  assert.equal(initialWindow.agentBlurStrength,'regular-material-plus-surface-fade');
  assert.equal(initialWindow.activeStepHighlightVisible,false);
  assert.equal(initialWindow.progressBarWidth,'step-title');
  assert.equal(initialWindow.agentPlacement,'after-step-title');
  assert.equal(initialWindow.agentIconSpacing,0);
  assert.equal(initialWindow.completedAgentCheck,'green-no-background');
  assert.equal(initialWindow.completedAgentCheckAnimation,'pop-then-periodic-rock');
  assert.equal(initialWindow.completedPlanRetentionSeconds,30);
  assert.equal(initialWindow.pendingStepAlignment,'reserved-column');
  assert.equal(initialWindow.noteAnimation,'blur-fade-rise-on-insert-and-change');
  assert.equal(initialWindow.noteTopSpacing,3);
  assert.equal(initialWindow.stepVerticalPadding,3);
  assert.equal(initialWindow.stepSpacing,0);
  assert.equal(initialWindow.framePersistence,'state.json');
  assert.equal(initialWindow.minimumWidth,280);
  const bundledIcons = (await readdir(join(binary,'..','..','Resources','agent-icons'))).filter(name=>name.endsWith('.png'));
  assert.equal(bundledIcons.length,10);
  checks.push('frameless window has one custom functional inside-edge cursor and no close or menu bar controls');
  const cursorCases = [
    [1, initialWindow.height / 2, 'left'],
    [initialWindow.width - 1, initialWindow.height / 2, 'right'],
    [initialWindow.width / 2, 1, 'top'],
    [initialWindow.width / 2, initialWindow.height - 1, 'bottom'],
    [1, 1, 'top-left'],
    [initialWindow.width - 1, 1, 'top-right'],
    [1, initialWindow.height - 1, 'bottom-left'],
    [initialWindow.width - 1, initialWindow.height - 1, 'bottom-right'],
    [initialWindow.width / 2, initialWindow.height / 2, 'arrow'],
  ];
  for (const [x,y,kind] of cursorCases) {
    assert.equal((await sendCompanion(socket,{action:'cursor_probe',x,y})).kind,kind);
  }
  checks.push('live inside-edge focus resolves edges, corners and window interior');
  checks.push('pending uses lowered staggered bouncing dots and all step status icons stay backgroundless');
  checks.push('thin animated blue progress bar starts its highlight at the leading edge and replaces the footer');
  checks.push('Codex palette and aligned emoji header use compact illustrated animated agent assets');
  checks.push('active step stays unboxed with title-width progress and inline agent icons');
  await sendCompanion(socket,{action:'set_frame',x:initialWindow.x,y:initialWindow.y,width:520,height:360});
  const tools = await a.listTools();
  assert.equal(tools.tools.find(t=>t.name==='show_task_plan')._meta?.ui, undefined);
  checks.push('companion mode exposes no iframe metadata');
  const first = await call(a,'create_task_plan',{title:'Companion A',steps:['Prepare','Verify']});
  const aid=first.plan_id; assert.equal((await delivered(aid,1)).selected, aid);
  const aidIcon=(await sendCompanion(socket,{action:'status'})).state.plans.find(p=>p.id===aid).icon;
  assert.ok(aidIcon);
  const second = await call(b,'create_task_plan',{title:'Companion B',steps:['Build','Check']});
  const bid=second.plan_id; assert.equal((await delivered(bid,1)).selected, bid);
  const switched=(await sendCompanion(socket,{action:'status'})).state;
  assert.equal(switched.selectorVisible,false); assert.equal(switched.planSwitcherAvailable,true);
  assert.ok(switched.plans.find(p=>p.id===bid).icon);
  checks.push('MCP creation selects a stable emoji plan icon without a menu selector');
  let update = await call(a,'update_task_plan_step',{plan_id:aid,step_id:'step-1',status:'in_progress',progress:37,
    note:'Measured checkpoint',agents:[{name:'worker',category:'testing',status:'working'}]});
  let state=await delivered(aid,update.revision);
  assert.equal(state.selected,bid); assert.equal(state.plans.find(p=>p.id===aid).steps[0].progress,37);
  assert.equal(state.plans.find(p=>p.id===aid).steps[0].agents[0].category,'testing');
  checks.push('progress notes workers delivered without selection change');
  for (const step_id of ['step-1','step-2']) update=await call(a,'update_task_plan_step',{plan_id:aid,step_id,status:'completed',agents:[{name:'worker',category:'testing',status:'completed'}]});
  state=await delivered(aid,update.revision); assert.equal(state.selected,aid);
  assert.equal(state.plans.find(p=>p.id===aid).status,'completed');
  checks.push('newly completed plan becomes selected immediately');
  await sendCompanion(socket,{action:'select',id:aid});
  const priorEvents=(await sendCompanion(socket,{action:'status'})).state.eventCount;
  await call(a,'record_task_plan_output',{plan_id:bid,points:1});
  await call(a,'get_task_plan',{plan_id:bid});
  await delay(100);
  assert.equal((await sendCompanion(socket,{action:'status'})).state.eventCount,priorEvents);
  checks.push('scores and unchanged reads produce no events');
  const concurrent=await Promise.all([a,b].map((client,i)=>call(client,'update_task_plan_step',{
    plan_id:bid,step_id:`step-${i+1}`,status:'in_progress',agents:[{name:`worker-${i}`,category:'testing'}]})));
  state=await delivered(bid,Math.max(...concurrent.map(v=>v.revision)));
  assert.ok(state.plans.find(p=>p.id===bid).steps.every(s=>s.status==='in_progress'));
  assert.equal(state.selected,aid); checks.push('two MCP writers preserve both updates and manual selection');
  const rejected=await a.callTool({name:'revise_task_plan',arguments:{plan_id:bid,remove_step_ids:['step-1']}});
  assert.equal(rejected.isError,true); checks.push('rejected mutation rolls back');
  await stop();
  update=await call(a,'update_task_plan_step',{plan_id:bid,step_id:'step-1',status:'completed'});
  await Promise.all(clients.map(c=>c.close()));
  const db=new DatabaseSync(dbPath); assert.ok(db.prepare('SELECT count(*) AS n FROM companion_outbox').get().n>0); db.close();
  await launch(); const c=await connect(); state=await delivered(bid,update.revision);
  const restartedWindow=(await sendCompanion(socket,{action:'status'})).state.window;
  assert.equal(restartedWindow.width,520); assert.equal(restartedWindow.height,360);
  assert.equal((await sendCompanion(socket,{action:'status'})).state.plans.find(p=>p.id===aid).icon,aidIcon);
  checks.push('window position and size survive restart');
  assert.equal(state.selected,aid); checks.push('offline durable outbox survives MCP and companion restart');
  const plan=state.plans.find(p=>p.id===bid);
  await sendCompanion(socket,{action:'event',selectOnCreate:true,plan});
  assert.equal((await saved()).selected,aid); checks.push('duplicate ACK replay does not reselect');
  const synthetic=(id,seq,creation)=>({id,title:id,revision:seq,source:'ordering-fixture',creationSequence:creation,steps:[{id:'one',title:'One',status:'pending'}]});
  await sendCompanion(socket,{action:'event',selectOnCreate:true,plan:synthetic('newer',20,20)});
  await sendCompanion(socket,{action:'event',selectOnCreate:true,plan:synthetic('older',10,10)});
  assert.equal((await saved()).selected,'newer'); checks.push('late older creation does not steal selection');
  const crashed = once(app,'exit'); app.kill('SIGKILL'); await crashed;
  update=await call(c,'update_task_plan_step',{plan_id:bid,step_id:'step-2',status:'in_progress',progress:60});
  await launch(); state=await delivered(bid,update.revision);
  assert.equal(state.selected,'newer'); checks.push('SIGKILL stale socket recovery and pending delivery');
  const parent = await call(c,'create_task_plan',{title:'Parent',steps:['Delegate','Integrate']});
  await delivered(parent.plan_id,1);
  const child=await call(c,'create_task_plan',{title:'Child',steps:['One','Two'],parent_plan_id:parent.plan_id,parent_step_id:'step-1'});
  for(const step_id of ['step-1','step-2']) await call(c,'update_task_plan_step',{plan_id:child.plan_id,step_id,status:'completed'});
  const parentState=await call(c,'get_task_plan',{plan_id:parent.plan_id});
  state=await delivered(parent.plan_id,parentState.plan.revision);
  assert.equal(state.selected,parent.plan_id); assert.ok(!state.plans.some(p=>p.id===child.plan_id));
  assert.equal(state.plans.find(p=>p.id===parent.plan_id).steps[0].status,'completed');
  checks.push('child changes propagate to root without creating a selectable child');
  await sendCompanion(socket,{action:'select',id:'newer'});
  await call(c,'cancel_task_plan',{plan_id:bid});
  await eventually(async()=> (await saved()).plans.find(p=>p.id===bid).status==='cancelled');
  assert.equal((await saved()).selected,'newer'); checks.push('cancellation delivered without reselection');
  await sendCompanion(socket,{action:'select',id:bid});
  await sendCompanion(socket,{action:'snapshot',name:'integration'});
  await writeFile(join(fixture,'report.json'),JSON.stringify({checks,passed:checks.length,fixture},null,2));
  console.log(JSON.stringify({passed:checks.length,checks,fixture},null,2));
} finally { await Promise.all(clients.map(c=>c.close())); if(app?.exitCode===null) await stop(); }
