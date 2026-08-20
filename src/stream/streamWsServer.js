const { attachStreamServers } = require('./agentPlayback');
const { handleConnection } = require('./streamHandler');

/**
 * Attaches Twilio Media Stream + agent browser playback WebSocket servers.
 * @param {import('http').Server} server
 */
const attachMediaStreamServer = (server) => {
  attachStreamServers(server, { onTwilioMedia: handleConnection });
};

module.exports = { attachMediaStreamServer };
