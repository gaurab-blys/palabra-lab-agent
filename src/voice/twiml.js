const Twilio = require('twilio');
const { getMediaStreamUrl, LANGUAGE_PAIRS } = require('../config');

const { VoiceResponse } = Twilio.twiml;

/**
 * Builds Connect/Stream TwiML for one call leg.
 *
 * @param {object} params
 * @param {string} params.pairId
 * @param {string} params.peerCallSid
 * @param {string} [params.sourceLanguage]
 * @param {string} [params.targetLanguage]
 * @param {'browser'|'twilio'} [params.playback]
 *   browser = Voice SDK agent (mic only on Twilio; TTS via /agent-playback)
 *   twilio  = PSTN client (TTS injected on this Connect/Stream)
 * @param {'agent'|'client'} [params.langPreset]
 * @returns {string}
 */
const buildLegTwiML = ({
  pairId,
  peerCallSid,
  sourceLanguage,
  targetLanguage,
  playback = 'twilio',
  langPreset,
}) => {
  const langs =
    sourceLanguage && targetLanguage
      ? { sourceLanguage, targetLanguage }
      : langPreset === 'client'
        ? LANGUAGE_PAIRS.client
        : LANGUAGE_PAIRS.agent;

  const twiml = new VoiceResponse();
  const stream = twiml.connect().stream({ url: getMediaStreamUrl() });
  stream.parameter({ name: 'pairId', value: String(pairId) });
  stream.parameter({ name: 'peerCallSid', value: String(peerCallSid) });
  stream.parameter({ name: 'playback', value: String(playback) });
  stream.parameter({ name: 'sourceLanguage', value: String(langs.sourceLanguage) });
  stream.parameter({ name: 'targetLanguage', value: String(langs.targetLanguage) });
  return twiml.toString();
};

module.exports = {
  buildLegTwiML,
};
