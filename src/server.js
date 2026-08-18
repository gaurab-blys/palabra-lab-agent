require('dotenv').config();

const http = require('http');
const express = require('express');
const path = require('path');
const logger = require('./logger');
const { PORT } = require('./config');
const voiceRoutes = require('./routes/voice');
const { attachMediaStreamServer } = require('./mediaStream');

const app = express();

app.use(
  '/vendor',
  express.static(path.join(__dirname, '../node_modules/@twilio/voice-sdk/dist'))
);

app.use(voiceRoutes);

const server = http.createServer(app);
attachMediaStreamServer(server);

server.listen(PORT, () => {
  logger.info(`[server] listening on port ${PORT}`);
});
