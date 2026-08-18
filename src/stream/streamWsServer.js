const WebSocket = require('ws');
const logger = require('../logger');
const { MEDIA_STREAM_PATH } = require('../config');
const { handleConnection } = require('./streamHandler');

/**
 * Attaches the Palabra media stream WebSocket upgrade handler to an HTTP server.
 * @param {import('http').Server} server
 */
const attachMediaStreamServer = (server) => {
  const wss = new WebSocket.WebSocketServer({ noServer: true });
  wss.on('connection', handleConnection);

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (_e) {
      return;
    }
    if (pathname !== MEDIA_STREAM_PATH) return socket.destroy();

    wss.handleUpgrade(req, socket, head, (sock) => {
      wss.emit('connection', sock, req);
    });
  });

  logger.info(`[stream] media stream listening on ${MEDIA_STREAM_PATH}`);
};

module.exports = { attachMediaStreamServer };
