const express = require('express');
const path = require('path');
const logger = require('../logger');
const { startOutboundPair, hangUp } = require('../voice/outboundCall');
const { getVoiceToken } = require('../voiceToken');
const {
  getLegByCallSid,
  getPeerByCallSid,
  removePair,
  listPairs,
} = require('../stream/sessionStore');
const { VOICE_WEBHOOK_PATH, VOICE_STATUS_PATH } = require('../config');

const TERMINAL_CALL_STATUSES = new Set([
  'completed',
  'busy',
  'no-answer',
  'failed',
  'canceled',
]);

/**
 * When one call ends, hang up its peer and clear the pair.
 * @param {string} callSid
 */
const hangUpPeerIfPaired = (callSid) => {
  if (!callSid) return;
  const self = getLegByCallSid(callSid);
  const peer = getPeerByCallSid(callSid);
  const peerCallSid = peer?.callSid;
  const pairId = self?.pairId || peer?.pairId;

  if (peer?.session) peer.session.end();
  if (self?.session) self.session.end();
  if (peerCallSid) hangUp(peerCallSid);
  if (pairId) removePair(pairId);
};

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'palabra-twilio-lab' });
});

/**
 * QA helper for TC-06: drop Palabra WebSocket(s) on the live call without hanging up Twilio.
 * The session reconnects (up to 3 times) or fails open — the phone call stays up.
 *
 * POST /debug/drop-palabra?callSid=CAxxx  (optional — omit to drop all legs)
 */
router.post('/debug/drop-palabra', (req, res) => {
  const onlyCallSid = req.query.callSid ? String(req.query.callSid) : null;

  const dropped = [];
  listPairs().forEach((pair) => {
    (pair.legs || []).forEach((leg) => {
      if (onlyCallSid && leg.callSid !== onlyCallSid) return;
      const session = leg.session;
      if (!session || typeof session.forceClose !== 'function') return;
      session.forceClose();
      dropped.push({
        pairId: pair.pairId,
        callSid: leg.callSid,
        peerCallSid: leg.peerCallSid,
      });
    });
  });

  logger.warn('[debug] Palabra WebSocket force-closed', { onlyCallSid, dropped });
  res.json({ ok: true, dropped });
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
 * Twilio voice status callback — hang up the opposite leg on terminal status.
 */
router.post(VOICE_STATUS_PATH, express.urlencoded({ extended: false }), (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  logger.info('[webhook] voice status', {
    CallSid: callSid,
    CallStatus: callStatus,
    StreamEvent: req.body.StreamEvent,
    StreamError: req.body.StreamError,
  });

  if (callSid && TERMINAL_CALL_STATUSES.has(String(callStatus || ''))) {
    logger.info('[webhook] terminal status — hanging up peer', { callSid, callStatus });
    hangUpPeerIfPaired(callSid);
  }

  res.sendStatus(204);
});

module.exports = router;
