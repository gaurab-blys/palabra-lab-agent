const Twilio = require('twilio');
const { getMediaStreamUrl, LANGUAGE_PAIRS } = require('../config');

const { VoiceResponse } = Twilio.twiml;

/**
 * Builds Connect/Stream TwiML for one call leg.
 * Language pair is embedded in custom parameters so each leg is deterministic.
 *
 * @param {object} params
 * @param {string} params.pairId
 * @param {'agent'|'client'} params.role
 * @param {string} [params.sourceLanguage]
 * @param {string} [params.targetLanguage]
 * @returns {string}
 */
const buildLegTwiML = ({ pairId, role, sourceLanguage, targetLanguage }) => {
  const langs =
    sourceLanguage && targetLanguage
      ? { sourceLanguage, targetLanguage }
      : role === 'agent'
        ? LANGUAGE_PAIRS.agent
        : LANGUAGE_PAIRS.client;

  const twiml = new VoiceResponse();
  const stream = twiml.connect().stream({ url: getMediaStreamUrl() });
  stream.parameter({ name: 'pairId', value: String(pairId) });
  stream.parameter({ name: 'role', value: String(role) });
  stream.parameter({ name: 'sourceLanguage', value: String(langs.sourceLanguage) });
  stream.parameter({ name: 'targetLanguage', value: String(langs.targetLanguage) });
  return twiml.toString();
};

module.exports = {
  buildLegTwiML,
};
