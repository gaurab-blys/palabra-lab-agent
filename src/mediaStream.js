/**
 * Compatibility wrapper.
 *
 * Implementation lives in:
 * - ./stream/streamHandler.js
 * - ./stream/streamWsServer.js
 */

const { handleConnection, INBOUND_CHUNK_BYTES } = require('./stream/streamHandler');
const { attachMediaStreamServer } = require('./stream/streamWsServer');

module.exports = {
  handleConnection,
  INBOUND_CHUNK_BYTES,
  attachMediaStreamServer,
};
