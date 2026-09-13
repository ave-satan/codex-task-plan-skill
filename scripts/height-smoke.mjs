// Deterministic measurement logic checks; not a browser/layout integration test.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const html = await readFile(new URL('../widget.html', import.meta.url), 'utf8');
const code = html.slice(html.indexOf('let heightFramePending'), html.indexOf('function alignProgressBars'));
const frames = [], reported = [];
let ready = false;
const shell = {offsetHeight: 125, classList: {contains: () => ready}};
const body = {get scrollHeight() {throw Error('Must not measure viewport scrollHeight');}};
const window = {openai: {notifyIntrinsicHeight: h => reported.push(h)}};
const notify = runInNewContext(code + '; notifyHeight;', {
  shell, window, document:{body}, getComputedStyle: () => ({paddingTop:'5px',paddingBottom:'5px'}),
  requestAnimationFrame: f => frames.push(f),
});
const flush = () => {while(frames.length) frames.shift()();};
notify(); flush(); assert.deepEqual(reported, []);
ready = true;
notify(); notify(); assert.equal(frames.length, 1); flush();
assert.deepEqual(reported, [135]);
notify(); flush(); assert.deepEqual(reported, [135]);
shell.offsetHeight = 280; notify(); flush();
shell.offsetHeight = 125; notify(); flush();
assert.deepEqual(reported, [135,290,135]);
window.openai = undefined; shell.offsetHeight=160; notify(); flush();
window.openai = {notifyIntrinsicHeight: h => reported.push(h)}; notify(); flush();
assert.deepEqual(reported, [135,290,135,170]);
console.log('Height logic passed: content+padding, shrink/grow, coalescing, deduplication, hidden state and absent bridge. Browser behavior not tested.');
