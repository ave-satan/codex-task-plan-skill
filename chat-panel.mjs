const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function hostThreadId(extra) {
  const meta = extra?._meta;
  const values = [meta?.thread_id, meta?.threadId].filter(value => value !== undefined);
  if (!values.length || values.some(value => typeof value !== 'string' || !uuid.test(value))) return null;
  const ids = values.map(value => value.toLowerCase());
  return ids.every(value => value === ids[0]) ? ids[0] : null;
}

export function planThreadId(plan, plans) {
  const visited = new Set();
  while (plan?.parentPlanId) {
    if (visited.has(plan.id)) return null;
    visited.add(plan.id);
    plan = plans.get(plan.parentPlanId);
  }
  const value = plan?.threadId ?? plan?.goalLink?.threadId;
  return typeof value === 'string' && uuid.test(value) ? value.toLowerCase() : null;
}

export function latestChatPlan(plans, threadId, now = Date.now()) {
  if (!threadId) return null;
  const roots = [...plans.values()].filter(plan => !plan.parentPlanId && planThreadId(plan, plans) === threadId);
  roots.sort((a, b) => b.createdAt.localeCompare(a.createdAt)
    || (b.createdSequence ?? 0) - (a.createdSequence ?? 0) || b.id.localeCompare(a.id));
  const plan = roots[0];
  if (!plan || plan.status === 'cancelled') return null;
  if (plan.status === 'completed' && (!plan.completedAt || now - Date.parse(plan.completedAt) >= 30_000)) return null;
  return plan;
}

// Same pool and stable UUID mapping as the companion: existing plans keep their icon.
const emojiPool = [
  '🫠','🫨','🥴','🤪','🫥','🫣','🥸','👹','👺','👻','👽','👾','🤖','💩','😈','👿','☠️','💀','🤯','🤤',
  '🤓','🧐','🥶','🥵','🤢','🤮','🤧','🤬','😵‍💫','😵','😶‍🌫️','😬','🙃','🤐','🫤',
  '🐙','🦑','🪼','🦀','🦞','🦐','🐡','🦈','🐊','🦎','🐍','🐲','🐉','🦖','🦕','🦧','🦍','🦥','🦦','🦨',
  '🦡','🦔','🐀','🐿️','🦇','🦉','🦤','🦚','🦩','🪿','🐓','🦃','🦆','🐸','🐌','🪲','🪳','🕷️','🦂','🦗',
  '🐛','🐝','🪰','🦟','🪱','🐗','🐐','🦙','🦒','🦛','🦘','🦣','🦬','🐫','🦏','🦫','🦭','🦠','🪸','🐚',
  '🍄','🌵','🪴','🧌','🗿','🧠','🫀','🫁','🦷','🦴','👁️','👀','👅','🫦','🦾','🦿','🧿','🔮','🪤','🧪',
  '🧫','🧬','🩻','🛸','🛰️','🚽','🪠','🧻','🛒','🧹','🪣','🪆','⚰️','🪦','🧲',
  '🍆','🍑','🌽','🥒','🫑','🧄','🧅','🥦','🥬','🥥','🥝','🥨','🧀','🧇','🥓','🍤','🦪','🍥','🧋','🫙',
];
export function planEmoji(id) {
  let hash = 1469598103934665603n;
  for (const byte of new TextEncoder().encode(id)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 1099511628211n);
  return emojiPool[Number(hash % BigInt(emojiPool.length))];
}
