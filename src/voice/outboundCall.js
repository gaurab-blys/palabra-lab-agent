const crypto = require('crypto');
const logger = require('../logger');
const { twilioClient } = require('./twilioClient');
const { buildLegTwiML } = require('./twiml');
const {
  registerPairCallSids,
  getLeg,
  removePair,
} = require('../stream/sessionStore');

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
 * Starts an outbound agent+client pair on Connect/Stream (no conference).
 * Dials the client leg, registers the pair, and returns agent TwiML.
 *
 * @param {{ from: string, to: string, agentCallSid: string }} params
 * @returns {Promise<string|null>} Agent leg TwiML, or null on dial failure
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
      twiml: buildLegTwiML({ pairId, role: 'client' }),
    });
  } catch (err) {
    logger.error('[outbound] client dial failed', { error: err.message });
    return null;
  }

  registerPairCallSids(pairId, { agentCallSid, clientCallSid: peerCall.sid });
  logger.info('[outbound] stream pair started', {
    pairId,
    agentCallSid,
    clientCallSid: peerCall.sid,
  });

  const t = setTimeout(() => {
    const clientLeg = getLeg(pairId, 'client');
    if (!clientLeg?.streamSid) {
      logger.warn('[outbound] client stream timed out', { pairId });
      hangUp(getLeg(pairId, 'agent')?.callSid || agentCallSid);
      hangUp(clientLeg?.callSid || peerCall.sid);
      removePair(pairId);
    }
  }, DIAL_TIMEOUT_MS);
  if (typeof t.unref === 'function') t.unref();

  return buildLegTwiML({ pairId, role: 'agent' });
};

/** @deprecated Use buildLegTwiML */
const streamTwiml = (pairId, role) => buildLegTwiML({ pairId, role });

module.exports = {
  buildLegTwiML,
  streamTwiml,
  hangUp,
  startOutboundPair,
};
