const crypto = require('crypto');
const WebSocket = require('ws');
const logger = require('./logger');
const { PALABRA_WS, PALABRA_AUDIO_FORMAT, PALABRA_PIPELINE } = require('./config');

const POLL_MS = 2100;
const MAX_POLLS = 5;
const MAX_RECONNECT = 3;
const RECONNECT_DELAYS_MS = [500, 1500, 4000];

/**
 * Builds the Palabra speech-to-speech WebSocket endpoint URL.
 * @returns {string}
 */
const buildEndpoint = () => {
  const hash = crypto.randomUUID();
  const token = process.env.PALABRA_API_KEY || PALABRA_WS.apiKey;
  return `${PALABRA_WS.baseUrl}/${hash}/v1/speech-to-speech/stream?token=${token}`;
};

/**
 * Builds the Palabra set_task message for a language pair.
 * @param {{ sourceLanguage: string, targetLanguage: string }} params
 * @returns {object}
 */
const buildSetTaskMessage = ({ sourceLanguage, targetLanguage }) => ({
  message_type: 'set_task',
  data: {
    input_stream: {
      content_type: 'audio',
      source: {
        type: 'ws',
        format: PALABRA_AUDIO_FORMAT.inputFormat,
        sample_rate: PALABRA_AUDIO_FORMAT.inputSampleRate,
        channels: PALABRA_AUDIO_FORMAT.channels,
      },
    },
    output_stream: {
      content_type: 'audio',
      target: {
        type: 'ws',
        format: PALABRA_AUDIO_FORMAT.outputFormat,
      },
    },
    pipeline: {
      transcription: {
        source_language: sourceLanguage,
        segment_confirmation_silence_threshold:
          PALABRA_PIPELINE.segmentConfirmationSilenceThreshold,
        only_confirm_by_silence: PALABRA_PIPELINE.onlyConfirmBySilence,
        sentence_splitter: { enabled: true },
      },
      translations: [
        {
          target_language: targetLanguage,
          translate_partial_transcriptions: false,
          speech_generation: {
            voice_cloning: false,
            voice_id: 'default_low',
          },
        },
      ],
      allowed_message_types: [
        'translated_transcription',
        'partial_transcription',
        'validated_transcription',
      ],
      translation_queue_configs: {
        global: {
          desired_queue_level_ms: PALABRA_PIPELINE.translationQueue.desiredQueueLevelMs,
          max_queue_level_ms: PALABRA_PIPELINE.translationQueue.maxQueueLevelMs,
          auto_tempo: PALABRA_PIPELINE.translationQueue.autoTempo,
          min_tempo: PALABRA_PIPELINE.translationQueue.minTempo,
          max_tempo: PALABRA_PIPELINE.translationQueue.maxTempo,
        },
      },
    },
  },
});

/**
 * Opens a Palabra speech-to-speech session over WebSocket.
 * @param {{ sourceLanguage: string, targetLanguage: string, onOutputAudio?: Function, onError?: Function }} params
 * @returns {{ sendAudio: Function, pause: Function, resume: Function, forceClose: Function, end: Function }}
 */
const createSession = ({ sourceLanguage, targetLanguage, onOutputAudio, onError }) => {
  const noop = {
    sendAudio: () => {},
    pause: () => {},
    resume: () => {},
    end: () => {},
  };

  const fail = (err) => {
    logger.error('[palabra] session error', err);
    if (typeof onError !== 'function') return;
    try {
      onError(err);
    } catch (cbErr) {
      logger.error('[palabra] onError threw', cbErr);
    }
  };

  const apiKey = process.env.PALABRA_API_KEY || PALABRA_WS.apiKey;
  if (!apiKey) {
    fail(new Error('PALABRA_API_KEY is empty'));
    return noop;
  }

  let ws;
  let open = false;
  let ready = false;
  let ended = false;
  let pollTimer;
  let reconnectTimer;
  let polls = 0;
  let reconnectAttempts = 0;

  const send = (msg) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      fail(err);
    }
  };

  const stopPoll = () => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = undefined;
  };

  const stopReconnect = () => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  };

  const markReady = () => {
    if (ready) return;
    ready = true;
    reconnectAttempts = 0;
    stopPoll();
    logger.info('[palabra] task ready', { sourceLanguage, targetLanguage });
  };

  const poll = () => {
    polls += 1;
    if (polls > MAX_POLLS) {
      logger.warn('[palabra] task not confirmed ready in time, sending anyway');
      markReady();
      return;
    }
    send({ message_type: 'get_task', data: { exclude_hidden: true } });
  };

  const startTask = () => {
    ready = false;
    polls = 0;
    stopPoll();
    send(buildSetTaskMessage({ sourceLanguage, targetLanguage }));
    pollTimer = setInterval(poll, POLL_MS);
  };

  /**
   * Opens (or re-opens) the Palabra streaming WebSocket and binds handlers.
   */
  const connect = () => {
    if (ended) return;

    try {
      ws = new WebSocket(buildEndpoint());
    } catch (err) {
      fail(err);
      return;
    }

    ws.on('open', () => {
      if (ended) return;
      open = true;
      logger.info('[palabra] ws open', {
        sourceLanguage,
        targetLanguage,
        reconnectAttempts,
      });
      startTask();
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        logger.warn('[palabra] non-json message', { error: err.message });
        return;
      }

      if (typeof msg.data === 'string') {
        try {
          msg.data = JSON.parse(msg.data);
        } catch (err) {
          logger.warn('[palabra] bad data string', { error: err.message, type: msg.message_type });
          return;
        }
      }

      switch (msg.message_type) {
        case 'current_task':
          markReady();
          break;

        case 'output_audio_data': {
          const audio = msg.data && msg.data.data;
          if (!audio) {
            logger.warn('[palabra] empty output_audio_data');
            break;
          }
          if (typeof onOutputAudio === 'function') {
            onOutputAudio({
              transcriptionId: msg.data.transcription_id,
              base64Audio: audio,
              lastChunk: !!msg.data.last_chunk,
            });
          }
          break;
        }

        case 'translated_transcription':
          logger.info('[palabra] translated text', {
            sourceLanguage,
            targetLanguage,
            text: msg.data && msg.data.transcription && msg.data.transcription.text,
            language: msg.data && msg.data.transcription && msg.data.transcription.language,
          });
          break;

        case 'warning':
          logger.warn('[palabra] warning', msg.data);
          break;

        case 'error':
          if (msg.data && msg.data.code === 'NOT_FOUND') {
            logger.warn('[palabra] NOT_FOUND (ignored)', {
              sourceLanguage,
              targetLanguage,
              ready,
              desc: msg.data.desc || msg.data.msg,
            });
            if (ready) startTask();
            break;
          }
          fail(new Error(`Palabra error ${msg.data.code}: ${msg.data.desc || msg.data.msg || ''}`));
          break;

        default:
          break;
      }
    });

    ws.on('error', (err) => {
      if (ended) return;
      logger.warn('[palabra] ws error', { error: err.message, sourceLanguage, targetLanguage });
    });

    ws.on('close', () => {
      open = false;
      ready = false;
      stopPoll();
      if (ended) return;

      if (reconnectAttempts >= MAX_RECONNECT) {
        logger.error('[palabra] ws closed, retries exhausted — call continues without translation', {
          sourceLanguage,
          targetLanguage,
          reconnectAttempts,
        });
        fail(new Error('Palabra WebSocket closed; retries exhausted'));
        return;
      }

      const delay = RECONNECT_DELAYS_MS[reconnectAttempts] || 4000;
      reconnectAttempts += 1;
      logger.warn('[palabra] ws closed, reconnecting', {
        sourceLanguage,
        targetLanguage,
        attempt: reconnectAttempts,
        max: MAX_RECONNECT,
        delayMs: delay,
      });
      stopReconnect();
      reconnectTimer = setTimeout(connect, delay);
    });
  };

  connect();

  return {
    // drop frames until current_task — buffering them blows AUDIO_STREAM_TOO_FAST
    sendAudio: (chunk) => {
      if (!open || !ready) return;
      send({ message_type: 'input_audio_data', data: { data: chunk } });
    },
    pause: () => {
      stopPoll();
      ready = false;
      send({ message_type: 'pause_task', data: {} });
    },
    resume: startTask,
    /**
     * Lab/QA helper: drop the Palabra socket without ending the session so reconnect runs.
     */
    forceClose: () => {
      if (!ws) return;
      try {
        ws.close();
      } catch (e) {
        // already closed
      }
    },
    end: () => {
      ended = true;
      stopPoll();
      stopReconnect();
      send({ message_type: 'end_task', data: {} });
      try {
        if (ws) ws.close();
      } catch (e) {
        // already closed
      }
    },
  };
};

module.exports = { createSession, buildSetTaskMessage, buildEndpoint };
