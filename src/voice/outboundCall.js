const crypto = require('crypto');
const logger = require('../logger');
const { twilioClient } = require('./twilioClient');
const { buildLegTwiML } = require('./twiml');
const {
  registerPair,
  getLegByCallSid,
  removePair,
} = require('../stream/sessionStore');
const { LANGUAGE_PAIRS } = require('../config');

const DIAL_TIMEOUT_MS = 35000;

/**
 * Hangs up a Twilio call leg.
 * @param {string} callSid
 * @returns {Promise<void>}
 */
const hangUp = async (callSid) => {
  if (!callSid || !twilioClient) return;
  try {
    await twilioClient.calls(callSid).update({ status: 'completed' });
  } catch (err) {
    logger.warn('[outbound] hangup failed', { callSid, error: err.message });
  }
};

/**
 * Starts agent (browser playback) + client (Twilio TTS) pair.
 *
 * @param {{ from: string, to: string, agentCallSid: string }} params
 * @returns {Promise<string|null>}
 */
const startOutboundPair = async ({ from, to, agentCallSid }) => {
  if (!from || !to || !agentCallSid) return null;
  if (!twilioClient) {
    logger.error('[outbound] Twilio client not configured');
    return null;
  }

  const pairId = crypto.randomUUID();

  let peerCall;
  try {
    peerCall = await twilioClient.calls.create({
      from,
      to,
      twiml: buildLegTwiML({
        pairId,
        peerCallSid: agentCallSid,
        ...LANGUAGE_PAIRS.client,
        langPreset: 'client',
        playback: 'twilio',
      }),
    });
  } catch (err) {
    logger.error('[outbound] client dial failed', { error: err.message });
    return null;
  }

  const clientCallSid = peerCall.sid;
  registerPair(pairId, {
    callSidA: agentCallSid,
    callSidB: clientCallSid,
    from,
    to,
  });

  logger.info('[outbound] stream pair started', {
    pairId,
    agentCallSid,
    clientCallSid,
    agentPlayback: 'browser',
    clientPlayback: 'twilio',
  });

  const t = setTimeout(() => {
    const clientLeg = getLegByCallSid(clientCallSid);
    if (!clientLeg?.streamSid) {
      logger.warn('[outbound] client stream timed out', { pairId, clientCallSid });
      hangUp(agentCallSid);
      hangUp(clientCallSid);
      removePair(pairId);
    }
  }, DIAL_TIMEOUT_MS);
  if (typeof t.unref === 'function') t.unref();

  return buildLegTwiML({
    pairId,
    peerCallSid: clientCallSid,
    ...LANGUAGE_PAIRS.agent,
    langPreset: 'agent',
    playback: 'browser',
  });
};

/**
 * @deprecated Prefer buildLegTwiML with peerCallSid + playback
 */
const streamTwiml = (pairId, langPreset, peerCallSid = 'PEER_PENDING') =>
  buildLegTwiML({
    pairId,
    peerCallSid,
    langPreset,
    playback: langPreset === 'agent' ? 'browser' : 'twilio',
  });

module.exports = {
  buildLegTwiML,
  streamTwiml,
  hangUp,
  startOutboundPair,
};
