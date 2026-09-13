import { createServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';

export async function registerSseProbe(mcp) {
  let report = { stage: 'not_started' };
  const requests = [];
  const token = randomUUID(), nonce = randomUUID();
  const cert = await readFile(process.env.TASK_PLAN_TLS_CERT);
  const key = await readFile(process.env.TASK_PLAN_TLS_KEY);
  const http = createServer({ cert, key }, (req, res) => {
    if (requests.length < 20) requests.push({ at: new Date().toISOString(), method: req.method,
      matchesEndpoint: req.url === `/events/${token}`, origin: req.headers.origin ?? null,
      preflightMethod: req.headers['access-control-request-method'] ?? null,
      privateNetwork: req.headers['access-control-request-private-network'] ?? null });
    if (req.url !== `/events/${token}` || req.method !== 'GET') {
      res.writeHead(404); res.end(); return;
    }
    report = { stage: 'connected' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
    res.flushHeaders();
    const timer = setTimeout(() => {
      report = { stage: 'sent' };
      res.end(`data: ${JSON.stringify({ value: 1, nonce })}\n\n`);
    }, 700);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  http.unref();
  const origin = `https://127.0.0.1:${http.address().port}`;
  const uri = 'ui://task-plan/sse-probe.html';
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><style>body{font:14px system-ui;color:#bfc4ce;background:transparent;padding:16px}</style><h3>SSE probe</h3><div id="status">Подключение…</div><script>
  const pending=new Map();let seq=0,stream,finished=false;const violations=[];
  const diagnostics=document.createElement('pre');diagnostics.style.whiteSpace='pre-wrap';document.body.append(diagnostics);
  function diagnose(text){diagnostics.textContent+=text+'\\n';send({method:'ui/notifications/size-changed',params:{height:300}})}
  addEventListener('securitypolicyviolation',e=>{const detail={directive:e.effectiveDirective,blocked:e.blockedURI.split('/events/')[0],disposition:e.disposition};violations.push(detail);diagnose('CSP: '+JSON.stringify(detail));request('tools/call',{name:'sse_probe_status',arguments:{action:'error',message:'CSP: '+JSON.stringify(detail)}}).catch(()=>{})});
  const send=m=>parent.postMessage({jsonrpc:'2.0',...m},'*');
  function request(method,params){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(Error(method+': timeout'))},8000);pending.set(id,{resolve,reject,timer});send({id,method,params})})}
  addEventListener('message',e=>{if(e.source!==parent)return;const m=e.data,p=pending.get(m?.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}});
  async function finish(action,message,nonce){if(finished)return;finished=true;stream?.close();document.getElementById('status').textContent=message;await request('tools/call',{name:'sse_probe_status',arguments:{action,message,nonce}}).catch(e=>diagnose('Отчёт не доставлен: '+e.message))}
  (async()=>{try{await request('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'sse-probe',version:'1'},appCapabilities:{}});send({method:'ui/notifications/initialized'});send({method:'ui/notifications/size-changed',params:{height:150}});
  await request('tools/call',{name:'sse_probe_status',arguments:{action:'mounted'}});
  diagnose('Bridge OK; endpoint: '+${JSON.stringify(origin)}+'; secureContext='+isSecureContext);
  stream=new EventSource(${JSON.stringify(`${origin}/events/${token}`)});
  stream.onmessage=e=>{try{const d=JSON.parse(e.data);finish('receipt','SSE событие получено: '+d.value,d.nonce)}catch(e){finish('error',String(e))}};
  stream.onopen=()=>diagnose('SSE open');
  stream.onerror=()=>{const state=stream.readyState;setTimeout(()=>finish('error',violations.length?'CSP blocked: '+JSON.stringify(violations):'SSE connection failed; readyState='+state+'; CSP event not observed'),100)};
  setTimeout(()=>finish('error','SSE timeout'),10000);
  }catch(e){finish('error',String(e))}})();
  </script></html>`;
  registerAppResource(mcp, 'SSE probe', uri, {}, async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html,
    _meta: { ui: { csp: { connectDomains: [origin] } }, 'openai/widgetCSP': { connect_domains: [origin], resource_domains: [] } } }] }));
  registerAppTool(mcp, 'show_sse_probe', { description: 'Open isolated loopback SSE test. Does not modify plans.', inputSchema: {},
    _meta: { ui: { resourceUri: uri }, 'openai/outputTemplate': uri } }, async () => ({ content: [{ type: 'text', text: 'SSE probe opened. Delivery requires iframe receipt.' }] }));
  registerAppTool(mcp, 'sse_probe_status', { description: 'Inspect SSE diagnostic or accept iframe receipt.',
    inputSchema: { action: z.enum(['status','mounted','receipt','error']), nonce: z.string().optional(), message: z.string().max(1000).optional() },
    _meta: { ui: { visibility: ['model','app'] } } }, async ({action,nonce: received,message}) => {
    if(action==='mounted') report={stage:'mounted'};
    if(action==='error') report={stage:'error',message};
    if(action==='receipt') report={stage:received===nonce&&report.stage==='sent'?'delivered':'invalid_receipt'};
    const snapshot={...report,processId:process.pid,endpointOrigin:origin,requests};
    return {content:[{type:'text',text:JSON.stringify(snapshot)}],structuredContent:snapshot};
  });
}
