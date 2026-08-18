const WebSocket = require('ws');
const logger = require('../logger');
const {
  TWILIO_AUDIO_FORMAT,
  PALABRA_AUDIO_FORMAT,
  LANGUAGE_PAIRS,
} = require('../config');
const {
  muLawBufferToPcm16,
  pcm16ToMuLawBuffer,
  pcm16BufferToInt16Array,
  int16ArrayToPcm16Buffer,
  resamplePcm16,
} = require('../audio');
const { createSession } = require('../palabraSession');
const {
  upsertLeg,
  getLeg,
  getOppositeLegByCallSid,
  detachLegByCallSid,
  getPairMeta,
  removePair,
} = require('./sessionStore');
const { hangUp } = require('../voice/outboundCall');

const CHUNK_BYTES = Math.round((TWILIO_AUDIO_FORMAT.sampleRate * PALABRA_AUDIO_FORMAT.chunkMs) / 1000);
const WS_OPEN = WebSocket.OPEN || 1;

/** ~2s of 8 kHz μ-law — hold TTS while the other leg is still ringing. */
const MAX_TTS_QUEUE_BYTES = 16000;

/**
 * Sends μ-law audio onto a Twilio media stream.
 * @param {object} peer
 * @param {Buffer|Uint8Array} muLawBytes
 * @returns {boolean}
 */
const deliverTtsToLeg = (peer, muLawBytes) => {
  if (!peer?.ws || !peer.streamSid || peer.ws.readyState !== WS_OPEN) return false;

  peer.ws.send(
    JSON.stringify({
      event: 'media',
      streamSid: peer.streamSid,
      media: { payload: Buffer.from(muLawBytes).toString('base64') },
    })
  );
  return true;
};

/**
 * Queues TTS for a peer that is not connected yet.
 * @param {string} pairId
 * @param {'agent'|'client'} peerRole
 * @param {Buffer|Uint8Array} muLawBytes
 */
const queueTtsForPeer = (pairId, peerRole, muLawBytes) => {
  const meta = getPairMeta(pairId);
  const chunk = Buffer.from(muLawBytes);
  const q = meta.ttsQueueFor[peerRole];
  let size = q.reduce((n, b) => n + b.length, 0);
  while (q.length && size + chunk.length > MAX_TTS_QUEUE_BYTES) {
    size -= q.shift().length;
  }
  if (size + chunk.length <= MAX_TTS_QUEUE_BYTES) {
    q.push(chunk);
  }
};

/**
 * Plays queued TTS once the peer stream is up.
 * @param {string} pairId
 * @param {'agent'|'client'} peerRole
 */
const flushTtsQueueForPeer = (pairId, peerRole) => {
  const meta = getPairMeta(pairId);
  const peer = getLeg(pairId, peerRole);
  const q = meta.ttsQueueFor[peerRole];
  if (!peer?.ws || !peer.streamSid || !q.length) return;

  let chunks = 0;
  let bytes = 0;
  while (q.length) {
    const chunk = q.shift();
    if (deliverTtsToLeg(peer, chunk)) {
      chunks += 1;
      bytes += chunk.length;
    } else {
      q.unshift(chunk);
      break;
    }
  }

  if (peerRole === 'agent' && bytes) {
    const playbackMs = Math.ceil((bytes / TWILIO_AUDIO_FORMAT.sampleRate) * 1000);
    upsertLeg({
      ...peer,
      suppressOutboundUntil: Date.now() + playbackMs + 80,
    });
  }

  if (chunks) {
    logger.info('[stream] flushed buffered TTS', {
      pairId,
      peerRole,
      toCallSid: peer.callSid,
      toStreamSid: peer.streamSid,
      chunks,
    });
  }
};

/**
 * Marks both legs connected and flushes any TTS that arrived during ring.
 * @param {string} pairId
 */
const markLegsPaired = (pairId) => {
  const agent = getLeg(pairId, 'agent');
  const client = getLeg(pairId, 'client');
  const meta = getPairMeta(pairId);

  if (!agent?.ws || !client?.ws) return;
  if (!agent.streamSid || !client.streamSid) return;
  if (meta.bothLegsReady) return;

  meta.bothLegsReady = true;
  logger.info('[stream] legs paired', {
    pairId,
    agentCallSid: agent.callSid,
    clientCallSid: client.callSid,
    agentStreamSid: agent.streamSid,
    clientStreamSid: client.streamSid,
  });

  flushTtsQueueForPeer(pairId, 'agent');
  flushTtsQueueForPeer(pairId, 'client');
};

/**
 * Handles a Twilio Media Stream WebSocket connection.
 * @param {import('ws').WebSocket} ws
 */
const handleConnection = (ws) => {
  const state = {
    buffer: [],
    seenIds: new Set(),
    callSid: undefined,
    streamSid: undefined,
    pairId: undefined,
    role: undefined,
    sourceLanguage: undefined,
    targetLanguage: undefined,
    session: undefined,
  };

  const flush = () => {
    if (!state.session) return;

    while (state.buffer.length >= CHUNK_BYTES) {
      const muLaw = Buffer.from(state.buffer.splice(0, CHUNK_BYTES));
      const pcm8k = muLawBufferToPcm16(muLaw);
      const pcmIn = resamplePcm16(
        pcm8k,
        TWILIO_AUDIO_FORMAT.sampleRate,
        PALABRA_AUDIO_FORMAT.inputSampleRate
      );
      state.lastT0 = Date.now();
      state.session.sendAudio(int16ArrayToPcm16Buffer(pcmIn).toString('base64'));
    }
  };

  const sendToPeer = (muLawBytes) => {
    const opposite = getOppositeLegByCallSid(state.callSid);
    if (!opposite) return;

    const peerReady =
      opposite.ws &&
      opposite.streamSid &&
      opposite.ws !== ws &&
      opposite.callSid !== state.callSid &&
      opposite.ws.readyState === WS_OPEN;

    if (!peerReady) {
      queueTtsForPeer(state.pairId, opposite.role, muLawBytes);
      if (!state.loggedPeerDrop) {
        state.loggedPeerDrop = true;
        logger.info('[stream] peer not ready, buffering TTS', {
          pairId: state.pairId,
          fromRole: state.role,
          toRole: opposite.role,
          fromCallSid: state.callSid,
          hasPeerWs: !!opposite.ws,
          peerCallSid: opposite.callSid,
        });
      }
      return;
    }

    if (opposite.role === 'agent') {
      const playbackMs = Math.ceil((muLawBytes.length / TWILIO_AUDIO_FORMAT.sampleRate) * 1000);
      upsertLeg({
        ...opposite,
        suppressOutboundUntil: Date.now() + playbackMs + 80,
      });
    }

    try {
      if (!deliverTtsToLeg(opposite, muLawBytes)) {
        queueTtsForPeer(state.pairId, opposite.role, muLawBytes);
        return;
      }
      if (!state.loggedTtsSent) {
        state.loggedTtsSent = true;
        logger.info('[stream] TTS sent to peer', {
          pairId: state.pairId,
          fromRole: state.role,
          toRole: opposite.role,
          fromCallSid: state.callSid,
          toCallSid: opposite.callSid,
          toStreamSid: opposite.streamSid,
          bytes: muLawBytes.length,
        });
      }
    } catch (err) {
      logger.warn('[stream] relay failed', {
        error: err.message,
        pairId: state.pairId,
        fromRole: state.role,
        toRole: opposite.role,
      });
    }
  };

  const onTts = ({ transcriptionId, base64Audio, lastChunk }) => {
    if (!base64Audio) return;

    const isFirst = transcriptionId && !state.seenIds.has(transcriptionId);
    const t1 = Date.now();
    if (isFirst) state.seenIds.add(transcriptionId);
    if (lastChunk && transcriptionId) state.seenIds.delete(transcriptionId);

    const pcm24k = pcm16BufferToInt16Array(Buffer.from(base64Audio, 'base64'));
    const pcm8k = resamplePcm16(
      pcm24k,
      PALABRA_AUDIO_FORMAT.outputSampleRate,
      TWILIO_AUDIO_FORMAT.sampleRate
    );
    sendToPeer(pcm16ToMuLawBuffer(pcm8k));

    if (isFirst && Number.isFinite(state.lastT0)) {
      logger.info('[latency] palabra', {
        callSid: state.callSid,
        direction: `${state.sourceLanguage}->${state.targetLanguage}`,
        transcriptionId,
        palabraMs: t1 - state.lastT0,
        e2eMs: Date.now() - state.lastT0,
      });
    }
  };

  const onStart = (payload) => {
    state.callSid = payload.callSid;
    state.streamSid = payload.streamSid;

    const custom = payload.customParameters || {};

    // TwiML customParameters are authoritative (same as ConversationRelay).
    state.pairId = custom.pairId;
    state.role = custom.role;
    state.sourceLanguage = custom.sourceLanguage;
    state.targetLanguage = custom.targetLanguage;

    if (!state.pairId || (state.role !== 'agent' && state.role !== 'client')) {
      logger.warn('[stream] missing pairId/role on start', {
        callSid: state.callSid,
        customParameters: custom,
      });
      return;
    }

    const langs =
      state.sourceLanguage && state.targetLanguage
        ? { sourceLanguage: state.sourceLanguage, targetLanguage: state.targetLanguage }
        : state.role === 'agent'
          ? LANGUAGE_PAIRS.agent
          : LANGUAGE_PAIRS.client;

    state.sourceLanguage = langs.sourceLanguage;
    state.targetLanguage = langs.targetLanguage;

    upsertLeg({
      pairId: state.pairId,
      role: state.role,
      callSid: state.callSid,
      streamSid: state.streamSid,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
      ws,
    });

    logger.info('[stream] leg registered', {
      pairId: state.pairId,
      role: state.role,
      callSid: state.callSid,
      streamSid: state.streamSid,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
    });

    state.session = createSession({
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
      onOutputAudio: onTts,
      onError: (err) => {
        logger.error('[stream] session error (call continues)', {
          callSid: state.callSid,
          pairId: state.pairId,
          error: err.message,
        });
      },
    });

    upsertLeg({
      pairId: state.pairId,
      role: state.role,
      callSid: state.callSid,
      streamSid: state.streamSid,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
      ws,
      session: state.session,
    });

    markLegsPaired(state.pairId);
  };

  const cleanup = () => {
    if (state.session) state.session.end();

    if (!state.callSid) return;

    const opposite = getOppositeLegByCallSid(state.callSid);
    detachLegByCallSid(state.callSid);

    // Either party hanging up ends the whole translation pair.
    if (opposite?.session) opposite.session.end();
    hangUp(opposite?.callSid);
    if (state.pairId) removePair(state.pairId);
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_e) {
      return;
    }

    if (msg.event === 'start') {
      onStart(msg.start);
      return;
    }
    if (msg.event === 'stop') {
      cleanup();
      return;
    }
    if (msg.event !== 'media' || !msg.media || !msg.media.payload) return;

    const track = msg.media.track || 'inbound';

    if (state.role === 'client' && track === 'outbound') return;

    if (state.role === 'agent') {
      const agentLeg = getLeg(state.pairId, 'agent');

      if (track === 'outbound') {
        if (agentLeg?.suppressOutboundUntil && Date.now() < agentLeg.suppressOutboundUntil) {
          return;
        }
        if (state.agentMicTrack !== 'outbound') {
          state.agentMicTrack = 'outbound';
          logger.info('[stream] agent mic track = outbound (Voice SDK)', {
            callSid: state.callSid,
          });
        }
      } else if (track === 'inbound') {
        if (state.agentMicTrack === 'outbound') return;
        state.agentMicTrack = 'inbound';
      }
    }

    if (!state.loggedMedia) {
      state.loggedMedia = true;
      logger.info('[stream] first media frame', {
        role: state.role,
        track,
        callSid: state.callSid,
      });
    }

    state.buffer.push(...Buffer.from(msg.media.payload, 'base64'));
    flush();
  });

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    logger.warn('[stream] media stream error', { error: err.message });
    cleanup();
  });
};

module.exports = {
  handleConnection,
  INBOUND_CHUNK_BYTES: CHUNK_BYTES,
};
