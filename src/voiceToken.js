const Twilio = require('twilio');
const { TWILIO_ACCOUNT_SID } = require('./config');

const { AccessToken } = Twilio.jwt;

/**
 * Issues a Twilio Voice SDK token for the lab browser agent page.
 * @returns {{ identity: string, token: string }|null}
 */
const getVoiceToken = () => {
  const apiKey = process.env.TWILIO_API_KEY || '';
  const apiSecret = process.env.TWILIO_API_SECRET || '';
  const voiceAppSid = process.env.TWILIO_VOICE_TWIML_APP_SID || '';

  if (!TWILIO_ACCOUNT_SID || !apiKey || !apiSecret || !voiceAppSid) {
    return null;
  }

  const identity = 'palabra-lab-agent';
  const accessToken = new AccessToken(TWILIO_ACCOUNT_SID, apiKey, apiSecret, {
    identity,
    ttl: 60 * 60,
  });

  accessToken.addGrant(
    new AccessToken.VoiceGrant({
      outgoingApplicationSid: voiceAppSid,
      incomingAllow: false,
    })
  );

  return { identity, token: accessToken.toJwt() };
};

module.exports = { getVoiceToken };
