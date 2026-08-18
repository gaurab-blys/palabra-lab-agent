require('dotenv').config();

const TWILIO_AUDIO_FORMAT = { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 };

const PALABRA_AUDIO_FORMAT = {
  inputFormat: 'pcm_s16le',
  inputSampleRate: 24000,
  outputFormat: 'pcm_s16le',
  outputSampleRate: 24000,
  channels: 1,
  chunkMs: 320,
};

const LANGUAGE_PAIRS = {
  agent: {
    sourceLanguage: process.env.AGENT_SOURCE_LANG || 'en',
    targetLanguage: process.env.AGENT_TARGET_LANG || 'hi',
  },
  client: {
    sourceLanguage: process.env.CLIENT_SOURCE_LANG || 'hi',
    targetLanguage: process.env.CLIENT_TARGET_LANG || 'en',
  },
};

const PALABRA_WS = {
  apiKey: process.env.PALABRA_API_KEY || '',
  baseUrl: process.env.PALABRA_WS_URL || 'wss://streaming.palabra.ai/streaming-api',
};

/** Matches blysnode `twilio.config.js` → `/api/v2/webhook/twilio` */
const TWILIO_WEBHOOK_BASE = '/api/v2/webhook/twilio';
const VOICE_WEBHOOK_PATH = `${TWILIO_WEBHOOK_BASE}/voice`;
const VOICE_STATUS_PATH = `${TWILIO_WEBHOOK_BASE}/voice/status`;
const MEDIA_STREAM_PATH = `${TWILIO_WEBHOOK_BASE}/voice/palabra-stream`;

const getMediaStreamUrl = () => {
  const base = (process.env.WEBHOOK_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
  return `${base.replace(/^http/, 'ws')}${MEDIA_STREAM_PATH}`;
};

const getVoiceWebhookUrl = () => {
  const base = (process.env.WEBHOOK_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
  return `${base}${VOICE_WEBHOOK_PATH}`;
};

const getVoiceStatusUrl = () => {
  const base = (process.env.WEBHOOK_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
  return `${base}${VOICE_STATUS_PATH}`;
};

module.exports = {
  PORT: parseInt(process.env.PORT || '4000', 10),
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER || '',
  WEBHOOK_BASE_URL: (process.env.WEBHOOK_BASE_URL || 'http://localhost:4000').replace(/\/$/, ''),
  LANGUAGE_PAIRS,
  TWILIO_AUDIO_FORMAT,
  PALABRA_AUDIO_FORMAT,
  PALABRA_WS,
  TWILIO_WEBHOOK_BASE,
  VOICE_WEBHOOK_PATH,
  VOICE_STATUS_PATH,
  MEDIA_STREAM_PATH,
  getMediaStreamUrl,
  getVoiceWebhookUrl,
  getVoiceStatusUrl,
};
