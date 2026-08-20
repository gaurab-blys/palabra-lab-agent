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
  getLegByCallSid,
  getPeerByCallSid,
  detachLegByCallSid,
  getPairMeta,
  removePair,
} = require('./sessionStore');
const { deliverToBrowserPlayback } = require('./agentPlayback');
const { hangUp } = require('../voice/outboundCall');

const CHUNK_BYTES = Math.round((TWILIO_AUDIO_FORMAT.sampleRate * PALABRA_AUDIO_FORMAT.chunkMs) / 1000);
const WS_OPEN = WebSocket.OPEN || 1;

/**
 * @param {string} pairId
 * @param {string} callSid
 * @param {string} peerCallSid
 */
const areBothLegsLive = (pairId, callSid, peerCallSid) => {
  const meta = getPairMeta(pairId);
  if (meta.bothLegsReady) return true;

  const self = getLegByCallSid(callSid);
  const peer = getLegByCallSid(peerCallSid);
  if (!self?.ws || !self.streamSid || !peer?.ws || !peer.streamSid) return false;
  if (self.ws === peer.ws || self.callSid === peer.callSid) return false;
  if (self.ws.readyState !== WS_OPEN || peer.ws.readyState !== WS_OPEN) return false;

  meta.bothLegsReady = true;
  logger.info('[stream] legs paired — translation unlocked', {
    pairId,
    callSidA: self.callSid,
    callSidB: peer.callSid,
    playbackA: self.playback,
    playbackB: peer.playback,
  });
  return true;
};

/**
 * Clears Twilio playback buffer on a PSTN leg.
 * @param {object} leg
 */
const clearTwilioPlayback = (leg) => {
  if (!leg?.ws || !leg.streamSid || leg.ws.readyState !== WS_OPEN) return;
  if (leg.playback === 'browser') return; // never touch agent Twilio return path
  try {
    leg.ws.send(JSON.stringify({ event: 'clear', streamSid: leg.streamSid }));
  } catch (err) {
    logger.warn('[stream] clear failed', { callSid: leg.callSid, error: err.message });
  }
};

/**
 * Deliver translated μ-law to the peer using the peer's playback mode.
 *
 * Architecture:
 * - Agent (browser): TTS goes to /agent-playback WebSocket → Web Audio in the page.
 *   NEVER injected onto the agent Twilio Connect/Stream (that was the mix bug).
 * - Client (twilio): TTS injected onto the client Connect/Stream WebSocket.
 *
 * @param {object} params
 * @param {string} params.fromCallSid
 * @param {string} params.toCallSid
 * @param {import('ws').WebSocket} params.originWs
 * @param {Buffer|Uint8Array} params.muLawBytes
 * @param {boolean} [params.clearFirst]
 * @returns {boolean}
 */
const deliverTranslatedToPeer = ({
  fromCallSid,
  toCallSid,
  originWs,
  muLawBytes,
  clearFirst,
}) => {
  if (!fromCallSid || !toCallSid || fromCallSid === toCallSid) {
    logger.warn('[stream] refused TTS — bad CallSids', { fromCallSid, toCallSid });
    return false;
  }

  const peer = getLegByCallSid(toCallSid);
  if (!peer) return false;

  if (peer.playback === 'browser') {
    const ok = deliverToBrowserPlayback(peer, muLawBytes);
    if (!ok && !peer.loggedBrowserDrop) {
      peer.loggedBrowserDrop = true;
      logger.info('[stream] browser playback not bound yet — drop TTS', {
        toCallSid,
        hint: 'open /agent and keep the page open during the call',
      });
    }
    return ok;
  }

  // PSTN / Twilio playback leg
  if (!peer.ws || !peer.streamSid || peer.ws.readyState !== WS_OPEN) return false;
  if (peer.ws === originWs) {
    logger.error('[stream] refused TTS — would write onto origin Twilio WS', {
      fromCallSid,
      toCallSid,
    });
    return false;
  }

  if (clearFirst) clearTwilioPlayback(peer);

  peer.ws.send(
    JSON.stringify({
      event: 'media',
      streamSid: peer.streamSid,
      media: { payload: Buffer.from(muLawBytes).toString('base64') },
    })
  );

  const playbackMs = Math.ceil((muLawBytes.length / TWILIO_AUDIO_FORMAT.sampleRate) * 1000);
  upsertLeg({
    pairId: peer.pairId,
    callSid: peer.callSid,
    peerCallSid: peer.peerCallSid,
    suppressInboundUntil: Date.now() + playbackMs + 120,
  });

  return true;
};

/**
 * @param {import('ws').WebSocket} ws
 */
const handleConnection = (ws) => {
  const state = {
    buffer: [],
    seenIds: new Set(),
    callSid: undefined,
    streamSid: undefined,
    pairId: undefined,
    peerCallSid: undefined,
    playback: 'twilio',
    sourceLanguage: undefined,
    targetLanguage: undefined,
    session: undefined,
  };

  const flushMicToPalabra = () => {
    if (!state.session) return;
    if (!areBothLegsLive(state.pairId, state.callSid, state.peerCallSid)) return;

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

  const sendTranslatedAudioToPeer = (muLawBytes, { clearFirst = false } = {}) => {
    if (!state.callSid || !state.peerCallSid) return;
    if (!areBothLegsLive(state.pairId, state.callSid, state.peerCallSid)) return;

    const ok = deliverTranslatedToPeer({
      fromCallSid: state.callSid,
      toCallSid: state.peerCallSid,
      originWs: ws,
      muLawBytes,
      clearFirst,
    });

    if (ok && !state.loggedTtsSent) {
      state.loggedTtsSent = true;
      const peer = getLegByCallSid(state.peerCallSid);
      logger.info('[stream] TTS to peer', {
        pairId: state.pairId,
        fromCallSid: state.callSid,
        toCallSid: state.peerCallSid,
        peerPlayback: peer?.playback,
        toStreamSid: peer?.playback === 'twilio' ? peer?.streamSid : undefined,
        via: peer?.playback === 'browser' ? 'agent-playback-ws' : 'twilio-media',
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
    sendTranslatedAudioToPeer(pcm16ToMuLawBuffer(pcm8k), { clearFirst: !!isFirst });

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
    state.pairId = custom.pairId;
    state.peerCallSid = custom.peerCallSid;
    state.playback = custom.playback === 'browser' ? 'browser' : 'twilio';
    state.sourceLanguage = custom.sourceLanguage;
    state.targetLanguage = custom.targetLanguage;

    if (!state.pairId || !state.peerCallSid) {
      logger.warn('[stream] missing pairId/peerCallSid on start', {
        callSid: state.callSid,
        customParameters: custom,
      });
      return;
    }

    if (state.peerCallSid === state.callSid) {
      logger.warn('[stream] peerCallSid equals callSid — refusing', { callSid: state.callSid });
      return;
    }

    if (!state.sourceLanguage || !state.targetLanguage) {
      const preset = LANGUAGE_PAIRS.agent;
      state.sourceLanguage = state.sourceLanguage || preset.sourceLanguage;
      state.targetLanguage = state.targetLanguage || preset.targetLanguage;
    }

    upsertLeg({
      pairId: state.pairId,
      callSid: state.callSid,
      peerCallSid: state.peerCallSid,
      streamSid: state.streamSid,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
      playback: state.playback,
      ws,
    });

    const peer = getLegByCallSid(state.peerCallSid);
    if (peer && peer.peerCallSid !== state.callSid) {
      upsertLeg({
        pairId: state.pairId,
        callSid: state.peerCallSid,
        peerCallSid: state.callSid,
      });
    }

    logger.info('[stream] leg registered', {
      pairId: state.pairId,
      callSid: state.callSid,
      peerCallSid: state.peerCallSid,
      streamSid: state.streamSid,
      playback: state.playback,
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
      callSid: state.callSid,
      peerCallSid: state.peerCallSid,
      streamSid: state.streamSid,
      sourceLanguage: state.sourceLanguage,
      targetLanguage: state.targetLanguage,
      playback: state.playback,
      ws,
      session: state.session,
    });

    areBothLegsLive(state.pairId, state.callSid, state.peerCallSid);
  };

  const cleanup = () => {
    if (state.cleanedUp) return;
    state.cleanedUp = true;

    if (state.session) {
      state.session.end();
      state.session = undefined;
    }
    if (!state.callSid) return;

    const peer = getPeerByCallSid(state.callSid);
    const peerCallSid = peer?.callSid;
    const pairId = state.pairId || peer?.pairId;

    detachLegByCallSid(state.callSid);

    if (peer?.session) peer.session.end();

    // One party left → always tear down the other call (client hangup ends agent, and vice versa).
    if (peerCallSid) {
      logger.info('[stream] peer hangup after leg left', {
        leftCallSid: state.callSid,
        hangUpCallSid: peerCallSid,
        pairId,
      });
      hangUp(peerCallSid);
    }

    if (pairId) removePair(pairId);
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
    if (track !== 'inbound') return;

    // Agent browser leg: never expect Twilio-return TTS; still guard PSTN echo.
    if (state.playback !== 'browser') {
      const self = getLegByCallSid(state.callSid);
      if (self?.suppressInboundUntil) {
        if (Date.now() < self.suppressInboundUntil) return;
        clearTwilioPlayback(self);
        upsertLeg({
          pairId: self.pairId,
          callSid: self.callSid,
          peerCallSid: self.peerCallSid,
          suppressInboundUntil: 0,
        });
      }
    }

    if (!state.loggedMedia) {
      state.loggedMedia = true;
      logger.info('[stream] first media frame', {
        track,
        callSid: state.callSid,
        playback: state.playback,
      });
    }

    if (!areBothLegsLive(state.pairId, state.callSid, state.peerCallSid)) {
      return;
    }

    state.buffer.push(...Buffer.from(msg.media.payload, 'base64'));
    flushMicToPalabra();
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
