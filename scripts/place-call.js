#!/usr/bin/env node
/**
 * Standalone Palabra lab call helper — no NAP required.
 *
 * Usage:
 *   npm run call -- --to +977CLIENT
 *   npm run call -- --to +977CLIENT --test-ring
 */

require('dotenv').config();

const Twilio = require('twilio');
const { twilioClient } = require('../src/voice/twilioClient');
const {
  TWILIO_FROM_NUMBER,
  WEBHOOK_BASE_URL,
  PORT,
  getVoiceWebhookUrl,
} = require('../src/config');

const parseArgs = () => {
  const args = process.argv.slice(2);
  let client = '';
  let testRing = false;

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--to' && args[i + 1]) {
      client = args[i + 1];
      i += 1;
    } else if (args[i] === '--test-ring') {
      testRing = true;
    }
  }

  return { client, testRing };
};

const main = async () => {
  const { client, testRing } = parseArgs();
  const callerNumber = TWILIO_FROM_NUMBER;
  const agentUrl = `http://localhost:${PORT}/agent?caller=${encodeURIComponent(callerNumber)}&client=${encodeURIComponent(client)}`;

  if (!callerNumber) {
    console.error('Error: set TWILIO_FROM_NUMBER in .env');
    process.exit(1);
  }

  if (!client) {
    console.error('Usage: npm run call -- --to +977CLIENT_PHONE');
    console.error('       npm run call -- --to +977CLIENT_PHONE --test-ring');
    process.exit(1);
  }

  if (!WEBHOOK_BASE_URL || WEBHOOK_BASE_URL.includes('xxxx')) {
    console.warn('Warning: set WEBHOOK_BASE_URL in .env to your ngrok HTTPS URL');
  }

  console.log('');
  console.log('Palabra lab — outbound call');
  console.log('──────────────────────────');
  console.log(`  Caller number:  ${callerNumber}`);
  console.log(`  Client number:  ${client}`);
  console.log(`  Voice webhook:  ${getVoiceWebhookUrl()}`);
  console.log('');

  if (testRing) {
    if (!twilioClient) {
      console.error('Error: TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN required for --test-ring');
      process.exit(1);
    }

    console.log('Test ring — dialing client (connectivity only)...');
    const twiml = new Twilio.twiml.VoiceResponse();
    twiml.say('Palabra lab connectivity test. Goodbye.');

    const call = await twilioClient.calls.create({
      from: callerNumber,
      to: client,
      twiml: twiml.toString(),
    });

    console.log(`Call placed: ${call.sid}`);
    console.log(`${client} should ring shortly.`);
    console.log('');
    return;
  }

  console.log('Start a translated call from the lab (no NAP):');
  console.log('');
  console.log('  1. ngrok http 4000');
  console.log('  2. Set TwiML App voice URL → WEBHOOK_BASE_URL/api/v2/webhook/twilio/voice');
  console.log('  3. npm run dev');
  console.log(`  4. Open ${agentUrl}`);
  console.log('  5. Click "Call client" (use your mic as the agent)');
  console.log('');
  console.log(`${client} will ring when you connect from the browser.`);
  console.log('');
  console.log('Connectivity test only (no translation):');
  console.log(`  npm run call -- --to ${client} --test-ring`);
  console.log('');
};

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
