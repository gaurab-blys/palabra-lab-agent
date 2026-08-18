const pairs = new Map();
const pairByCall = new Map();

const emptyLeg = () => ({
  callSid: undefined,
  ws: undefined,
  streamSid: undefined,
  session: undefined,
});

/**
 * Returns a call pair by pairId.
 * @param {string} pairId
 * @returns {object|undefined}
 */
const getPair = (pairId) => pairs.get(pairId);

/**
 * Removes a pair and its CallSid mappings.
 * @param {string} pairId
 */
const removePair = (pairId) => {
  const pair = pairs.get(pairId);
  if (!pair) return;
  if (pair.agent.callSid) pairByCall.delete(pair.agent.callSid);
  if (pair.client.callSid) pairByCall.delete(pair.client.callSid);
  pairs.delete(pairId);
};

/**
 * Registers or updates a call pair with agent/client CallSids.
 * @param {string} pairId
 * @param {{ agentCallSid?: string, clientCallSid?: string }} fields
 * @returns {object}
 */
const registerPair = (pairId, { agentCallSid, clientCallSid } = {}) => {
  const pair = pairs.get(pairId) || {
    pairId,
    agent: emptyLeg(),
    client: emptyLeg(),
  };
  if (agentCallSid) {
    pair.agent.callSid = agentCallSid;
    pairByCall.set(agentCallSid, pairId);
  }
  if (clientCallSid) {
    pair.client.callSid = clientCallSid;
    pairByCall.set(clientCallSid, pairId);
  }
  pairs.set(pairId, pair);
  return pair;
};

/**
 * Attaches fields to an agent or client leg.
 * @param {string} pairId
 * @param {'agent'|'client'} role
 * @param {object} fields
 * @returns {object|undefined}
 */
const attachLeg = (pairId, role, fields = {}) => {
  if (!pairId || (role !== 'agent' && role !== 'client')) return undefined;
  const pair = pairs.get(pairId) || registerPair(pairId);
  Object.assign(pair[role], fields);
  if (fields.callSid) pairByCall.set(fields.callSid, pairId);
  return pair;
};

/**
 * Looks up a leg by CallSid.
 * @param {string} callSid
 * @returns {object|undefined}
 */
const getByCall = (callSid) => {
  const pairId = pairByCall.get(callSid);
  const pair = pairId && pairs.get(pairId);
  if (!pair) return undefined;
  const isAgent = pair.agent.callSid === callSid;
  const leg = isAgent ? pair.agent : pair.client;
  return { ...leg, pairId, role: isAgent ? 'agent' : 'client' };
};

/**
 * Resolves pairId + role from pre-registered CallSids.
 * @param {string} callSid
 * @returns {{ pairId: string, role: string }|undefined}
 */
const resolveRoleFromCallSid = (callSid) => {
  const pairId = pairByCall.get(callSid);
  if (!pairId) return undefined;
  const pair = pairs.get(pairId);
  if (!pair) return undefined;
  if (pair.agent.callSid === callSid) return { pairId, role: 'agent' };
  if (pair.client.callSid === callSid) return { pairId, role: 'client' };
  return undefined;
};

/**
 * Removes a pair by CallSid if one is registered.
 * @param {string} callSid
 */
const removeByCallSid = (callSid) => {
  const pairId = pairByCall.get(callSid);
  if (pairId) removePair(pairId);
};

const registry = {
  registerPair,
  attachLeg,
  getPair,
  get: getByCall,
  setSession: (callSid, session) => {
    const entry = getByCall(callSid);
    if (!entry) return;
    attachLeg(entry.pairId, entry.role, { session });
  },
  remove: removeByCallSid,
  removePair,
};

module.exports = {
  getPair,
  removePair,
  registerPair,
  attachLeg,
  getByCall,
  resolveRoleFromCallSid,
  removeByCallSid,
  registry,
};
