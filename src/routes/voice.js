const express = require('express');
const path = require('path');
const logger = require('../logger');
const { startOutboundPair } = require('../voice/outboundCall');
const { getVoiceToken } = require('../voiceToken');
const { listPairs } = require('../stream/sessionStore');
const { VOICE_WEBHOOK_PATH, VOICE_STATUS_PATH } = require('../config');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'palabra-twilio-lab' });
});

/**
 * QA helper for TC-06: drop Palabra WebSocket(s) on the live call without hanging up Twilio.
 * The session reconnects (up to 3 times) or fails open — the phone call stays up.
 *
 * POST /debug/drop-palabra?role=agent|client|both
 */
router.post('/debug/drop-palabra', (req, res) => {
  const role = String(req.query.role || 'both');
  if (!['agent', 'client', 'both'].includes(role)) {
    res.status(400).json({ error: 'role must be agent, client, or both' });
    return;
  }

  const dropped = [];
  listPairs().forEach((pair) => {
    ['agent', 'client'].forEach((leg) => {
      if (role !== 'both' && role !== leg) return;
      const session = pair[leg] && pair[leg].session;
      if (!session || typeof session.forceClose !== 'function') return;
      session.forceClose();
      dropped.push({ pairId: pair.pairId, role: leg, callSid: pair[leg].callSid });
    });
  });

  logger.warn('[debug] Palabra WebSocket force-closed', { role, dropped });
  res.json({ ok: true, role, dropped });
});

/** Built-in browser agent (standalone — no NAP required). */
router.get('/agent', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/agent.html'));
});

/** Twilio Voice SDK access token for /agent page. */
router.get('/api/voice-token', (_req, res) => {
  const token = getVoiceToken();
  if (!token) {
    res.status(503).json({
      error:
        'Missing TWILIO_API_KEY, TWILIO_API_SECRET, or TWILIO_VOICE_TWIML_APP_SID in .env',
    });
    return;
  }
  res.json(token);
});

/**
 * Twilio voice webhook — same path as blysnode POST /api/v2/webhook/twilio/voice.
 * Agent leg connects here; we dial the client and return agent Connect/Stream TwiML.
 */
router.post(VOICE_WEBHOOK_PATH, express.urlencoded({ extended: false }), async (req, res) => {
  const agentCallSid = req.body.CallSid;
  const clientNumber = req.query.to || req.body.To;
  const callerId = req.body.From || req.query.from;

  logger.info('[webhook] voice', { agentCallSid, callerId, clientNumber });

  if (!agentCallSid || !clientNumber || !callerId) {
    res.status(400).type('text/plain').send('Missing CallSid, From/callerId, or To/client');
    return;
  }

  const twiml = await startOutboundPair({
    from: callerId,
    to: clientNumber,
    agentCallSid,
  });

  if (!twiml) {
    res.status(502).type('text/plain').send('Failed to start outbound pair');
    return;
  }

  res.type('text/xml').send(twiml);
});

/**
 * Twilio voice status callback — same path as blysnode POST /api/v2/webhook/twilio/voice/status.
 */
router.post(VOICE_STATUS_PATH, express.urlencoded({ extended: false }), (req, res) => {
  logger.info('[webhook] voice status', {
    CallSid: req.body.CallSid,
    CallStatus: req.body.CallStatus,
    StreamEvent: req.body.StreamEvent,
    StreamError: req.body.StreamError,
  });
  res.sendStatus(204);
});

module.exports = router;
