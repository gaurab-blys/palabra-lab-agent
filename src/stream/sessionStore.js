/**
 * Pair registry keyed by Twilio CallSid.
 *
 * playback:
 * - 'twilio'  — PSTN leg; TTS is injected onto that Connect/Stream WebSocket
 * - 'browser' — Voice SDK agent; TTS is NEVER injected on the Twilio call
 *               (played in the browser over /agent-playback instead)
 */

const byCallSid = new Map();
const pairMeta = new Map();

const emptyPairMeta = () => ({
  bothLegsReady: false,
  from: undefined,
  to: undefined,
});

/**
 * @param {string} pairId
 */
const getPairMeta = (pairId) => {
  if (!pairId) return emptyPairMeta();
  if (!pairMeta.has(pairId)) pairMeta.set(pairId, emptyPairMeta());
  return pairMeta.get(pairId);
};

/**
 * @param {object} params
 * @param {string} params.pairId
 * @param {string} params.callSid
 * @param {string} [params.peerCallSid]
 * @param {string} [params.streamSid]
 * @param {string} [params.sourceLanguage]
 * @param {string} [params.targetLanguage]
 * @param {'twilio'|'browser'} [params.playback]
 * @param {import('ws').WebSocket} [params.ws]
 * @param {import('ws').WebSocket|null} [params.browserWs]
 * @param {object} [params.session]
 * @param {number} [params.suppressInboundUntil]
 */
const upsertLeg = ({
  pairId,
  callSid,
  peerCallSid,
  streamSid,
  sourceLanguage,
  targetLanguage,
  playback,
  ws,
  browserWs,
  session,
  suppressInboundUntil,
}) => {
  if (!pairId || !callSid) return undefined;

  const existing = byCallSid.get(callSid);

  const entry = {
    pairId,
    callSid,
    peerCallSid: peerCallSid || existing?.peerCallSid,
    streamSid: streamSid !== undefined ? streamSid : existing?.streamSid,
    sourceLanguage: sourceLanguage || existing?.sourceLanguage,
    targetLanguage: targetLanguage || existing?.targetLanguage,
    playback: playback || existing?.playback || 'twilio',
    ws: ws !== undefined ? ws : existing?.ws,
    browserWs: browserWs !== undefined ? browserWs : existing?.browserWs,
    session: session !== undefined ? session : existing?.session,
    suppressInboundUntil:
      suppressInboundUntil !== undefined
        ? suppressInboundUntil
        : existing?.suppressInboundUntil,
  };

  byCallSid.set(callSid, entry);
  getPairMeta(pairId);
  return entry;
};

/**
 * @param {string} pairId
 * @param {{ callSidA: string, callSidB: string, from?: string, to?: string }} params
 */
const registerPair = (pairId, { callSidA, callSidB, from, to } = {}) => {
  if (!pairId || !callSidA || !callSidB || callSidA === callSidB) return;
  upsertLeg({
    pairId,
    callSid: callSidA,
    peerCallSid: callSidB,
    playback: 'browser',
  });
  upsertLeg({
    pairId,
    callSid: callSidB,
    peerCallSid: callSidA,
    playback: 'twilio',
  });
  const meta = getPairMeta(pairId);
  if (from) meta.from = from;
  if (to) meta.to = to;
};

/**
 * Finds the browser (agent) leg for a dialed from/to pair.
 * @param {string} from
 * @param {string} to
 */
const findBrowserLegByDial = (from, to) => {
  if (!from || !to) return undefined;
  for (const metaEntry of pairMeta.entries()) {
    const [pairId, meta] = metaEntry;
    if (meta.from !== from || meta.to !== to) continue;
    const legs = [...byCallSid.values()].filter((l) => l.pairId === pairId);
    return legs.find((l) => l.playback === 'browser');
  }
  return undefined;
};

/**
 * @param {string} callSid
 */
const getLegByCallSid = (callSid) => byCallSid.get(callSid);

/**
 * @param {string} callSid
 */
const getPeerByCallSid = (callSid) => {
  const self = byCallSid.get(callSid);
  if (!self?.peerCallSid) return undefined;
  return byCallSid.get(self.peerCallSid);
};

/**
 * @param {string} callSid
 */
const detachLegByCallSid = (callSid) => {
  const entry = byCallSid.get(callSid);
  if (!entry) return;

  byCallSid.set(callSid, {
    ...entry,
    ws: null,
    streamSid: undefined,
    session: undefined,
    suppressInboundUntil: undefined,
    // keep browserWs so playback can survive brief media reconnects
  });
};

/**
 * @param {string} pairId
 */
const removePair = (pairId) => {
  if (!pairId) return;
  [...byCallSid.values()]
    .filter((leg) => leg.pairId === pairId)
    .forEach((leg) => {
      if (leg.browserWs && leg.browserWs.readyState === 1) {
        try {
          leg.browserWs.close();
        } catch (_e) {
          // ignore
        }
      }
      byCallSid.delete(leg.callSid);
    });
  pairMeta.delete(pairId);
};

/**
 * @returns {object[]}
 */
const listPairs = () => {
  const byPair = new Map();
  byCallSid.forEach((leg) => {
    if (!byPair.has(leg.pairId)) byPair.set(leg.pairId, []);
    byPair.get(leg.pairId).push(leg);
  });

  return [...byPair.entries()].map(([pairId, legs]) => ({
    pairId,
    legs,
    meta: getPairMeta(pairId),
  }));
};

const registry = {
  registerPair: (pairId, fields = {}) => {
    if (fields.callSidA && fields.callSidB) {
      registerPair(pairId, fields);
      return;
    }
    if (fields.agentCallSid && fields.clientCallSid) {
      registerPair(pairId, {
        callSidA: fields.agentCallSid,
        callSidB: fields.clientCallSid,
        from: fields.from,
        to: fields.to,
      });
    }
  },
  attachLeg: (pairId, _unused, fields = {}) => {
    const callSid = fields.callSid;
    if (!callSid) return undefined;
    return upsertLeg({ pairId, ...fields, callSid });
  },
  getPair: (pairId) => {
    const legs = [...byCallSid.values()].filter((l) => l.pairId === pairId);
    if (!legs.length) return undefined;
    return { pairId, legs, ...getPairMeta(pairId) };
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
  registerPair,
  findBrowserLegByDial,
  getLegByCallSid,
  getPeerByCallSid,
  detachLegByCallSid,
  getPairMeta,
  removePair,
  listPairs,
  registry,
};
