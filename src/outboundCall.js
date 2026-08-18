const crypto = require('crypto');
const Twilio = require('twilio');
const logger = require('./logger');
const { getMediaStreamUrl } = require('./config');
const { twilioClient } = require('./twilioClient');
const { registerPair, getPair, removePair } = require('./pairRegistry');

const { VoiceResponse } = Twilio.twiml;

const DIAL_TIMEOUT_MS = 35000;

/**
 * Builds Connect/Stream TwiML for one call leg.
 * @param {string} pairId
 * @param {'agent'|'client'} role
 * @returns {string}
 */
const streamTwiml = (pairId, role) => {
  const twiml = new VoiceResponse();
  const stream = twiml.connect().stream({ url: getMediaStreamUrl() });
  stream.parameter({ name: 'pairId', value: String(pairId) });
  stream.parameter({ name: 'role', value: String(role) });
  return twiml.toString();
};

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
      twiml: streamTwiml(pairId, 'client'),
    });
  } catch (err) {
    logger.error('[outbound] client dial failed', { error: err.message });
    return null;
  }

  registerPair(pairId, { agentCallSid, clientCallSid: peerCall.sid });
  logger.info('[outbound] stream pair started', {
    pairId,
    agentCallSid,
    clientCallSid: peerCall.sid,
  });

  const t = setTimeout(() => {
    const pair = getPair(pairId);
    if (!pair || pair.client?.streamSid) return;
    logger.warn('[outbound] client stream timed out', { pairId });
    hangUp(pair.agent?.callSid || agentCallSid);
    hangUp(pair.client?.callSid || peerCall.sid);
    removePair(pairId);
  }, DIAL_TIMEOUT_MS);
  if (typeof t.unref === 'function') t.unref();

  return streamTwiml(pairId, 'agent');
};

module.exports = {
  streamTwiml,
  hangUp,
  startOutboundPair,
};
