const WebSocket = require('ws');
const logger = require('../logger');
const { AGENT_PLAYBACK_PATH } = require('../config');
const { findBrowserLegByDial, upsertLeg, getLegByCallSid } = require('./sessionStore');

const WS_OPEN = WebSocket.OPEN || 1;

/**
 * Sends μ-law TTS to the browser agent page (never onto the Twilio agent call).
 * @param {object} agentLeg
 * @param {Buffer|Uint8Array} muLawBytes
 * @returns {boolean}
 */
const deliverToBrowserPlayback = (agentLeg, muLawBytes) => {
  const browserWs = agentLeg?.browserWs;
  if (!browserWs || browserWs.readyState !== WS_OPEN) return false;

  browserWs.send(
    JSON.stringify({
      event: 'audio',
      format: 'mulaw',
      sampleRate: 8000,
      payload: Buffer.from(muLawBytes).toString('base64'),
    })
  );
  return true;
};

/**
 * Binds a browser WebSocket to the agent leg for local TTS playback.
 * @param {import('ws').WebSocket} ws
 */
const handleAgentPlaybackConnection = (ws) => {
  let boundCallSid;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_e) {
      return;
    }

    if (msg.event !== 'bind') return;

    const from = msg.from && String(msg.from);
    const to = msg.to && String(msg.to);
    const callSid = msg.callSid && String(msg.callSid);

    let leg = callSid ? getLegByCallSid(callSid) : undefined;
    if (!leg || leg.playback !== 'browser') {
      leg = findBrowserLegByDial(from, to);
    }

    if (!leg || leg.playback !== 'browser') {
      logger.info('[playback] bind waiting for agent leg', { from, to, callSid });
      ws.send(JSON.stringify({ event: 'pending', from, to }));
      return;
    }

    boundCallSid = leg.callSid;
    upsertLeg({
      pairId: leg.pairId,
      callSid: leg.callSid,
      peerCallSid: leg.peerCallSid,
      browserWs: ws,
      playback: 'browser',
    });

    logger.info('[playback] browser bound to agent leg', {
      callSid: leg.callSid,
      pairId: leg.pairId,
    });
    ws.send(JSON.stringify({ event: 'bound', callSid: leg.callSid, pairId: leg.pairId }));
  });

  const unbind = () => {
    if (!boundCallSid) return;
    const leg = getLegByCallSid(boundCallSid);
    if (leg?.browserWs === ws) {
      upsertLeg({
        pairId: leg.pairId,
        callSid: leg.callSid,
        peerCallSid: leg.peerCallSid,
        browserWs: null,
        playback: 'browser',
      });
    }
  };

  ws.on('close', unbind);
  ws.on('error', unbind);
};

/**
 * Attaches /agent-playback upgrade handling onto an existing noServer wss router.
 * @param {import('http').Server} server
 * @param {{ onTwilioMedia: Function }} handlers
 */
const attachStreamServers = (server, { onTwilioMedia }) => {
  const twilioWss = new WebSocket.WebSocketServer({ noServer: true });
  const playbackWss = new WebSocket.WebSocketServer({ noServer: true });

  twilioWss.on('connection', onTwilioMedia);
  playbackWss.on('connection', handleAgentPlaybackConnection);

  const { MEDIA_STREAM_PATH } = require('../config');

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_e) {
      return;
    }

    if (pathname === MEDIA_STREAM_PATH) {
      twilioWss.handleUpgrade(req, socket, head, (sock) => {
        twilioWss.emit('connection', sock, req);
      });
      return;
    }

    if (pathname === AGENT_PLAYBACK_PATH) {
      playbackWss.handleUpgrade(req, socket, head, (sock) => {
        playbackWss.emit('connection', sock, req);
      });
      return;
    }

    socket.destroy();
  });

  logger.info(`[stream] media stream listening on ${MEDIA_STREAM_PATH}`);
  logger.info(`[playback] agent browser audio listening on ${AGENT_PLAYBACK_PATH}`);
};

module.exports = {
  deliverToBrowserPlayback,
  handleAgentPlaybackConnection,
  attachStreamServers,
};
