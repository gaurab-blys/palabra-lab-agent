require('dotenv').config();

const http = require('http');
const express = require('express');
const path = require('path');
const logger = require('./logger');
const config = require('./config');
const voiceRoutes = require('./routes/voice');
const { attachMediaStreamServer } = require('./stream/streamWsServer');

const app = express();

app.use(
  '/vendor',
  express.static(path.join(__dirname, '../node_modules/@twilio/voice-sdk/dist'))
);
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(voiceRoutes);

const server = http.createServer(app);
attachMediaStreamServer(server);

server.listen(config.PORT, () => {
  logger.info(`[server] listening on port ${config.PORT}`);
  logger.info('[server] voice webhook', { path: config.VOICE_WEBHOOK_PATH });
  logger.info('[server] media stream', { path: config.MEDIA_STREAM_PATH });
});
