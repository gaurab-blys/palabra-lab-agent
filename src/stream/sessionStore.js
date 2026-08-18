const byCallSid = new Map();
const byPairRole = new Map();
const pairMeta = new Map();

const roleOpposite = (role) =>
  role === 'agent' ? 'client' : role === 'client' ? 'agent' : undefined;

const emptyPairMeta = () => ({
  bothLegsReady: false,
  ttsQueueFor: { agent: [], client: [] },
});

/**
 * Returns pair-level metadata (TTS queues, pairing flags).
 * @param {string} pairId
 * @returns {{ bothLegsReady: boolean, ttsQueueFor: { agent: Buffer[], client: Buffer[] } }}
 */
const getPairMeta = (pairId) => {
  if (!pairId) return emptyPairMeta();
  if (!pairMeta.has(pairId)) pairMeta.set(pairId, emptyPairMeta());
  return pairMeta.get(pairId);
};

/**
 * Registers or updates one media-stream leg.
 * Mirrors conversationrelay-translation-lab sessionStore.upsertLeg.
 *
 * @param {object} params
 * @param {string} params.pairId
 * @param {'agent'|'client'} params.role
 * @param {string} [params.callSid]
 * @param {string} [params.streamSid]
 * @param {string} [params.sourceLanguage]
 * @param {string} [params.targetLanguage]
 * @param {import('ws').WebSocket} [params.ws]
 * @param {object} [params.session]
 * @param {number} [params.suppressOutboundUntil]
 */
const upsertLeg = ({
  pairId,
  role,
  callSid,
  streamSid,
  sourceLanguage,
  targetLanguage,
  ws,
  session,
  suppressOutboundUntil,
}) => {
  if (!pairId || (role !== 'agent' && role !== 'client')) return undefined;

  const key = `${pairId}:${role}`;
  const existing = byPairRole.get(key);

  const entry = {
    pairId,
    role,
    callSid: callSid || existing?.callSid,
    streamSid: streamSid !== undefined ? streamSid : existing?.streamSid,
    sourceLanguage: sourceLanguage || existing?.sourceLanguage,
    targetLanguage: targetLanguage || existing?.targetLanguage,
    ws: ws !== undefined ? ws : existing?.ws,
    session: session !== undefined ? session : existing?.session,
    suppressOutboundUntil:
      suppressOutboundUntil !== undefined
        ? suppressOutboundUntil
        : existing?.suppressOutboundUntil,
  };

  byPairRole.set(key, entry);
  if (entry.callSid) byCallSid.set(entry.callSid, entry);
  getPairMeta(pairId);
  return entry;
};

/**
 * Pre-registers CallSids for a pair before media streams connect.
 * @param {string} pairId
 * @param {{ agentCallSid?: string, clientCallSid?: string }} fields
 */
const registerPairCallSids = (pairId, { agentCallSid, clientCallSid } = {}) => {
  if (agentCallSid) upsertLeg({ pairId, role: 'agent', callSid: agentCallSid });
  if (clientCallSid) upsertLeg({ pairId, role: 'client', callSid: clientCallSid });
};

/**
 * @param {string} pairId
 * @param {'agent'|'client'} role
 */
const getLeg = (pairId, role) => byPairRole.get(`${pairId}:${role}`);

/**
 * @param {string} callSid
 */
const getLegByCallSid = (callSid) => byCallSid.get(callSid);

/**
 * Gets the opposite leg for a given callSid.
 * @param {string} callSid
 */
const getOppositeLegByCallSid = (callSid) => {
  const entry = byCallSid.get(callSid);
  if (!entry) return undefined;
  const opposite = roleOpposite(entry.role);
  if (!opposite) return undefined;
  return byPairRole.get(`${entry.pairId}:${opposite}`);
};

/**
 * Clears live WS/stream/session fields while keeping leg metadata for reconnect.
 * @param {string} callSid
 */
const detachLegByCallSid = (callSid) => {
  const entry = byCallSid.get(callSid);
  if (!entry) return;

  const updated = {
    ...entry,
    ws: null,
    streamSid: undefined,
    session: undefined,
    suppressOutboundUntil: undefined,
  };

  byPairRole.set(`${entry.pairId}:${entry.role}`, updated);
  byCallSid.set(callSid, updated);
};

/**
 * Removes a pair and all leg mappings.
 * @param {string} pairId
 */
const removePair = (pairId) => {
  ['agent', 'client'].forEach((role) => {
    const entry = byPairRole.get(`${pairId}:${role}`);
    if (entry?.callSid) byCallSid.delete(entry.callSid);
    byPairRole.delete(`${pairId}:${role}`);
  });
  pairMeta.delete(pairId);
};

/**
 * Returns every active pair with both legs and pair metadata.
 * @returns {object[]}
 */
const listPairs = () => {
  const pairIds = new Set();
  byPairRole.forEach((entry) => pairIds.add(entry.pairId));

  return [...pairIds].map((pairId) => ({
    pairId,
    agent: getLeg(pairId, 'agent') || {},
    client: getLeg(pairId, 'client') || {},
    meta: getPairMeta(pairId),
  }));
};

/**
 * Backward-compatible registry surface used by tests and debug routes.
 */
const registry = {
  registerPair: registerPairCallSids,
  attachLeg: (pairId, role, fields = {}) => upsertLeg({ pairId, role, ...fields }),
  getPair: (pairId) => {
    const agent = getLeg(pairId, 'agent');
    const client = getLeg(pairId, 'client');
    if (!agent && !client) return undefined;
    return {
      pairId,
      agent: agent || {},
      client: client || {},
      ...getPairMeta(pairId),
    };
  },
  get: getLegByCallSid,
  setSession: (callSid, session) => {
    const entry = getLegByCallSid(callSid);
    if (!entry) return;
    upsertLeg({ ...entry, session });
  },
  remove: (callSid) => {
    const entry = getLegByCallSid(callSid);
    if (entry) removePair(entry.pairId);
  },
  removePair,
  listPairs,
};

module.exports = {
  upsertLeg,
  registerPairCallSids,
  getLeg,
  getLegByCallSid,
  getOppositeLegByCallSid,
  detachLegByCallSid,
  getPairMeta,
  removePair,
  listPairs,
  registry,
};
