const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const logger = require('./logger');
const {
  LANGUAGE_PAIRS,
  TWILIO_AUDIO_FORMAT,
  PALABRA_AUDIO_FORMAT,
  MEDIA_STREAM_PATH,
} = require('./config');
const {
  muLawBufferToPcm16,
  pcm16ToMuLawBuffer,
  pcm16BufferToInt16Array,
  int16ArrayToPcm16Buffer,
  resamplePcm16,
} = require('./audio');
const { createSession } = require('./palabraSession');
const {
  getPair,
  attachLeg,
  removePair,
  resolveRoleFromCallSid,
  removeByCallSid,
} = require('./pairRegistry');
const { hangUp } = require('./outboundCall');

const CHUNK_BYTES = Math.round(
  (TWILIO_AUDIO_FORMAT.sampleRate * PALABRA_AUDIO_FORMAT.chunkMs) / 1000
);
const WS_OPEN = WebSocket.OPEN || 1;
/** ~2s of 8 kHz μ-law — hold Hindi/English TTS while the other leg is still ringing. */
const MAX_TTS_QUEUE_BYTES = 16000;

/**
 * Ensures per-pair TTS queues exist.
 * @param {object} pair
 */
const ensurePairState = (pair) => {
  if (!pair.ttsQueueFor) {
    pair.ttsQueueFor = { agent: [], client: [] };
  }
};

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
 * @param {object} pair
 * @param {'agent'|'client'} peerRole
 * @param {Buffer|Uint8Array} muLawBytes
 */
const queueTtsForPeer = (pair, peerRole, muLawBytes) => {
  ensurePairState(pair);
  const chunk = Buffer.from(muLawBytes);
  const q = pair.ttsQueueFor[peerRole];
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
 * @param {object} pair
 * @param {'agent'|'client'} peerRole
 */
const flushTtsQueueForPeer = (pair, peerRole) => {
  ensurePairState(pair);
  const peer = pair[peerRole];
  const q = pair.ttsQueueFor[peerRole];
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
    peer.suppressOutboundUntil = Date.now() + playbackMs + 80;
  }
  if (chunks) {
    logger.info('[stream] flushed buffered TTS', {
      pairId: pair.pairId,
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
  const pair = getPair(pairId);
  if (!pair?.agent?.ws || !pair?.client?.ws) return;
  if (!pair.agent.streamSid || !pair.client.streamSid) return;
  if (pair.bothLegsReady) return;

  pair.bothLegsReady = true;
  logger.info('[stream] legs paired', {
    pairId,
    agentCallSid: pair.agent.callSid,
    clientCallSid: pair.client.callSid,
    agentStreamSid: pair.agent.streamSid,
    clientStreamSid: pair.client.streamSid,
  });

  flushTtsQueueForPeer(pair, 'agent');
  flushTtsQueueForPeer(pair, 'client');
};

/**
 * Handles a Twilio Media Stream WebSocket connection.
 * Mirrors blysnode src/api/v3/services/voiceTranslation/palabra.js handleConnection.
 * @param {import('ws').WebSocket} ws
 */
const handleConnection = (ws) => {
  const state = {
    buffer: [],
    seenIds: new Set(),
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
    const pair = getPair(state.pairId);
    if (!pair) return;

    const peerRole = state.role === 'agent' ? 'client' : 'agent';
    const peer = pair[peerRole];

    const peerReady =
      peer?.ws &&
      peer.streamSid &&
      peer.ws !== ws &&
      peer.callSid !== state.callSid &&
      peer.ws.readyState === WS_OPEN;

    if (!peerReady) {
      queueTtsForPeer(pair, peerRole, muLawBytes);
      if (!state.loggedPeerDrop) {
        state.loggedPeerDrop = true;
        logger.info('[stream] peer not ready, buffering TTS', {
          pairId: state.pairId,
          fromRole: state.role,
          toRole: peerRole,
          fromCallSid: state.callSid,
          hasPeerWs: !!peer?.ws,
          peerCallSid: peer?.callSid,
        });
      }
      return;
    }

    if (peerRole === 'agent') {
      const playbackMs = Math.ceil((muLawBytes.length / TWILIO_AUDIO_FORMAT.sampleRate) * 1000);
      peer.suppressOutboundUntil = Date.now() + playbackMs + 80;
    }

    try {
      if (!deliverTtsToLeg(peer, muLawBytes)) {
        queueTtsForPeer(pair, peerRole, muLawBytes);
        return;
      }
      if (!state.loggedTtsSent) {
        state.loggedTtsSent = true;
        logger.info('[stream] TTS sent to peer', {
          pairId: state.pairId,
          fromRole: state.role,
          toRole: peerRole,
          fromCallSid: state.callSid,
          toCallSid: peer.callSid,
          toStreamSid: peer.streamSid,
          bytes: muLawBytes.length,
        });
      }
    } catch (err) {
      logger.warn('[stream] relay failed', {
        error: err.message,
        pairId: state.pairId,
        fromRole: state.role,
        toRole: peerRole,
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
        direction: state.direction,
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
    const mapped = resolveRoleFromCallSid(state.callSid);
    const pairId = mapped?.pairId || custom.pairId;
    const role = mapped?.role || custom.role;

    if (mapped && custom.role && custom.role !== mapped.role) {
      logger.warn('[stream] custom role disagrees with CallSid mapping; using CallSid', {
        callSid: state.callSid,
        customRole: custom.role,
        resolvedRole: mapped.role,
        pairId: mapped.pairId,
      });
    }

    if (!pairId || (role !== 'agent' && role !== 'client')) {
      logger.warn('[stream] missing pairId/role on start', {
        callSid: state.callSid,
        customParameters: custom,
      });
      return;
    }

    state.pairId = pairId;
    state.role = role;

    const langs = role === 'agent' ? LANGUAGE_PAIRS.agent : LANGUAGE_PAIRS.client;
    state.direction = `${langs.sourceLanguage}->${langs.targetLanguage}`;

    attachLeg(pairId, role, {
      callSid: state.callSid,
      streamSid: state.streamSid,
      ws,
    });

    logger.info('[stream] media stream connected', {
      pairId,
      role,
      callSid: state.callSid,
      streamSid: state.streamSid,
      direction: state.direction,
      roleSource: mapped ? 'callSid' : 'customParameters',
    });

    state.session = createSession({
      sourceLanguage: langs.sourceLanguage,
      targetLanguage: langs.targetLanguage,
      onOutputAudio: onTts,
      onError: (err) => {
        logger.error('[stream] session error (call continues)', {
          callSid: state.callSid,
          pairId,
          error: err.message,
        });
      },
    });
    attachLeg(pairId, role, { session: state.session });

    markLegsPaired(pairId);
  };

  const cleanup = () => {
    // Palabra session for this specific leg is tied to this media stream WS,
    // so when the media stream ends we stop only this leg's session.
    if (state.session) state.session.end();

    const pair = state.pairId ? getPair(state.pairId) : undefined;
    if (!pair) return;

    const peer = state.role === 'agent' ? pair.client : pair.agent;

    // Clear the closed leg's WS + stream metadata but keep the pair as long as the peer
    // media stream is still connected. This mirrors the "separate legs" behavior from
    // conversationrelay-translation-lab.
    try {
      attachLeg(state.pairId, state.role, {
        ws: undefined,
        streamSid: undefined,
        session: undefined,
      });
    } catch (_e) {
      // Non-fatal: cleanup continues.
    }

    const peerWsAlive =
      peer?.ws &&
      peer.ws.readyState === WS_OPEN &&
      peer.streamSid;

    // If the peer leg is still alive, keep the call up and let the peer continue translating.
    if (peerWsAlive) return;

    // If both legs are down (or the peer is down too), finish the whole pair.
    if (peer?.session) peer.session.end();
    hangUp(peer?.callSid);
    removePair(state.pairId);
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
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

    // Client outbound is TTS we injected onto the PSTN call — never loop it into Palabra.
    if (state.role === 'client' && track === 'outbound') return;

    if (state.role === 'agent') {
      const pair = getPair(state.pairId);
      const agentLeg = pair?.agent;

      if (track === 'outbound') {
        // Twilio Voice SDK: browser mic is outbound. Skip only while our TTS is playing
        // on this leg (that echo is also tagged outbound).
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
        // Bidirectional Connect/Stream: mic is inbound. Once Voice SDK outbound
        // appears, inbound is the remote mix (empty here) — do not send it to Palabra.
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

/**
 * Attaches the Palabra media stream WebSocket upgrade handler to an HTTP server.
 * @param {import('http').Server} server
 */
const attachMediaStreamServer = (server) => {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', handleConnection);

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (e) {
      return;
    }
    if (pathname !== MEDIA_STREAM_PATH) return;

    wss.handleUpgrade(req, socket, head, (sock) => {
      wss.emit('connection', sock, req);
    });
  });

  logger.info(`[stream] media stream listening on ${MEDIA_STREAM_PATH}`);
};

module.exports = {
  handleConnection,
  attachMediaStreamServer,
  INBOUND_CHUNK_BYTES: CHUNK_BYTES,
};
