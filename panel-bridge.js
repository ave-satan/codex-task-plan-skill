const panelListeners = new Set();
const panelInstanceId = crypto.randomUUID();
const panelRetiredGenerations = new Set();
let panelApp;
let panelLatest;
let panelLatestSignature = '';
let panelExpectedThread = null;
let panelIdentityViolation = false;
let panelVersion = null;
let panelLastAcceptedRead = 0;
let panelReadSequence = 0;
let panelReadInFlight = null;
let panelReadAbort = null;
let panelRefreshWanted = false;
let panelConnected = false;
let panelDisposed = false;
let panelTimer = null;
let panelPendingAck = null;
let panelAckInFlight = false;
let panelReleaseInFlight = null;

document.documentElement.dataset.panelInstance = panelInstanceId;
const panelUUID = value => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const panelStableValue = value => {
  if (Array.isArray(value)) return value.map(panelStableValue);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, panelStableValue(value[key])]),
  );
  return value;
};
const panelPublish = value => {
  if (panelDisposed) return;
  const signature = JSON.stringify(panelStableValue({
    thread_id: value.thread_id,
    plan: value.plan,
    message: value.message ?? '',
  }));
  panelLatest = value;
  if (signature === panelLatestSignature) return;
  panelLatestSignature = signature;
  for (const listener of panelListeners) listener(value);
};
const panelClear = (message, thread = null) => panelPublish({
  panel: true, thread_id: thread, plan: null, message,
});
const panelUnavailable = () => {
  document.documentElement.dataset.panelSync = 'retrying';
  // A transient transport error does not change the bound chat. Preserve its
  // last rendered plan and animations; unknown/changed identity still clears it.
  if (!panelLatest?.plan) panelClear('План временно недоступен', panelExpectedThread);
};
const panelAccept = (envelope, source, sequence = 0) => {
  if (panelDisposed || !envelope || envelope.panel !== true) return;
  if (panelIdentityViolation) return;
  // Cached opening-tool notifications may predate this mounted panel. Bind
  // and paint from a fresh read that carries the current host chat metadata.
  if (source === 'notification' && panelLastAcceptedRead === 0) return;
  const thread = panelUUID(envelope.thread_id) ? envelope.thread_id.toLowerCase() : null;
  if (!thread) {
    panelClear(typeof envelope.message === 'string' ? envelope.message : 'Не удалось определить текущий чат');
    return;
  }
  if (panelExpectedThread && thread !== panelExpectedThread) {
    panelIdentityViolation = true;
    clearTimeout(panelTimer);
    panelClear('Открой панель заново в этом чате');
    return;
  }
  panelExpectedThread ??= thread;
  if (envelope.panel_duplicate === true) {
    panelIdentityViolation = true;
    clearTimeout(panelTimer);
    panelClear('План этого чата уже открыт', thread);
    try {
      if (typeof window.openai?.requestClose === 'function') window.openai.requestClose();
      else void panelApp.requestTeardown().catch(() => {});
    } catch { void panelApp.requestTeardown().catch(() => {}); }
    return;
  }
  const version = envelope.storeVersion;
  if (!version || typeof version.generation !== 'string' || !version.generation
      || !Number.isSafeInteger(version.revision) || version.revision < 0) {
    panelClear('Не удалось обновить план', thread);
    return;
  }
  if (panelVersion) {
    if (version.generation === panelVersion.generation) {
      if (version.revision < panelVersion.revision) return;
    } else {
      // Notifications can arrive after a newer read, including after a DB
      // reset. Only the latest read can establish a new generation.
      if (source !== 'read' || sequence < panelLastAcceptedRead
          || panelRetiredGenerations.has(version.generation)) return;
      panelRetiredGenerations.add(panelVersion.generation);
    }
  }
  if (source === 'read') panelLastAcceptedRead = Math.max(panelLastAcceptedRead, sequence);
  if (panelLatest?.storeVersion?.generation === version.generation
      && panelLatest.plan?.id === envelope.plan?.id
      && envelope.plan && envelope.plan.revision < panelLatest.plan.revision) return;
  panelVersion = { generation: version.generation, revision: version.revision };
  if (envelope.plan !== null && (!envelope.plan || !panelUUID(envelope.plan.id)
      || !Number.isSafeInteger(envelope.plan.revision) || envelope.plan.revision < 0
      || !Array.isArray(envelope.plan.steps))) {
    panelClear('Не удалось обновить план', thread);
    return;
  }
  panelPublish({ ...envelope, thread_id: thread });
};
const panelSchedule = () => {
  clearTimeout(panelTimer);
  if (!panelDisposed && !panelIdentityViolation && panelConnected && !document.hidden) {
    panelTimer = setTimeout(panelRefresh, 1000);
  }
};
const panelRefresh = () => {
  clearTimeout(panelTimer);
  if (panelDisposed || panelIdentityViolation || !panelConnected || document.hidden) return Promise.resolve();
  if (panelReadInFlight) {
    panelRefreshWanted = true;
    return panelReadInFlight;
  }
  const sequence = ++panelReadSequence;
  const snapshotAtStart = panelLatest;
  panelReadAbort = new AbortController();
  panelReadInFlight = Promise.resolve().then(async () => {
    try {
      const result = await panelApp.callServerTool({ name: 'get_chat_task_plan', arguments: { instance_id: panelInstanceId } },
        { signal: panelReadAbort.signal, timeout: 8000 });
      if (panelDisposed) return;
      if (result.isError || result.structuredContent?.panel !== true) {
        if (panelLatest === snapshotAtStart) panelUnavailable();
        return;
      }
      panelAccept(result.structuredContent, 'read', sequence);
      document.documentElement.dataset.panelSync = 'connected';
    } catch {
      if (!panelDisposed) {
        document.documentElement.dataset.panelSync = 'retrying';
        if (panelLatest === snapshotAtStart) panelUnavailable();
      }
    } finally {
      panelReadInFlight = null;
      panelReadAbort = null;
      const wanted = panelRefreshWanted;
      panelRefreshWanted = false;
      if (wanted && !panelDisposed && !panelIdentityViolation && !document.hidden) {
        queueMicrotask(panelRefresh);
      } else panelSchedule();
    }
  });
  return panelReadInFlight;
};
const panelDrainAck = async () => {
  if (panelAckInFlight || !panelConnected || panelDisposed) return;
  panelAckInFlight = true;
  try {
    while (panelPendingAck && !panelDisposed) {
      const acknowledgement = panelPendingAck;
      panelPendingAck = null;
      try {
        await panelApp.callServerTool({ name: 'ack_task_plan_panel', arguments: acknowledgement },
          { timeout: 8000 });
      } catch { /* A missing render receipt must not affect the read-only view. */ }
    }
  } finally { panelAckInFlight = false; }
};
const panelDispose = (close = false) => {
  if (panelDisposed) return;
  panelDisposed = true;
  clearTimeout(panelTimer);
  panelReadAbort?.abort();
  panelPendingAck = null;
  panelListeners.clear();
  if (close) {
    try { Promise.resolve(panelApp?.close?.()).catch(() => {}); } catch {}
  }
};
const panelRelease = () => {
  if (!panelConnected) return Promise.resolve();
  panelReleaseInFlight ??= panelApp.callServerTool({ name: 'release_task_plan_panel', arguments: { instance_id: panelInstanceId } },
    { timeout: 1500 }).catch(() => {});
  return panelReleaseInFlight;
};

window.taskPlanPanel = {
  onState(listener) {
    panelListeners.add(listener);
    if (panelLatest) listener(panelLatest);
    return () => panelListeners.delete(listener);
  },
  rendered(value) {
    if (panelDisposed || !panelLatest) return;
    const plan = panelLatest.plan;
    if (plan && (value.plan_id !== plan.id || value.revision !== plan.revision)) return;
    if (!plan && (value.plan_id != null || value.revision != null)) return;
    const acknowledgement = { instance_id: panelInstanceId, counter: String(value.counter ?? '').slice(0, 40) };
    if (plan) {
      acknowledgement.plan_id = plan.id;
      acknowledgement.revision = plan.revision;
    }
    panelPendingAck = acknowledgement;
    void panelDrainAck();
  },
};
window.addEventListener('pagehide', () => {
  const release = panelRelease();
  panelDispose();
  void release.finally(() => { try { Promise.resolve(panelApp?.close?.()).catch(() => {}); } catch {} });
}, { once: true });
document.addEventListener('visibilitychange', () => {
  clearTimeout(panelTimer);
  if (!document.hidden) void panelRefresh();
});

try {
  if (window.parent === window) {
    panelClear('Открой панель из чата Codex');
  } else {
    panelApp = new __PANEL_APP_CLASS__({ name: 'Task Plan', version: '0.2.1' }, {}, { autoResize: true });
    // Register all host notifications before the initialization handshake.
    panelApp.ontoolresult = result => panelAccept(result.structuredContent, 'notification');
    panelApp.onhostcontextchanged = () => { void panelRefresh(); };
    panelApp.onteardown = async () => { panelDispose(); await panelRelease(); return {}; };
    panelApp.onerror = () => {
      if (panelConnected && !panelDisposed) panelUnavailable();
    };
    await panelApp.connect();
    if (!panelDisposed) {
      panelConnected = true;
      document.documentElement.dataset.panelEnvironment = 'mcp-app';
      void panelDrainAck();
      void panelRefresh();
    }
  }
} catch {
  panelClear('Не удалось подключить панель');
}
window.dispatchEvent(new Event('task-plan-panel-ready'));
