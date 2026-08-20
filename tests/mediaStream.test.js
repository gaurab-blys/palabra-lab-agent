const mockUpdate = jest.fn();
const mockCreate = jest.fn();
const mockCalls = Object.assign(
  jest.fn(() => ({ update: mockUpdate })),
  {
    create: (...args) => mockCreate(...args),
  }
);

jest.mock('../src/voice/twilioClient', () => ({
  twilioClient: { calls: mockCalls },
}));

const mockSession = { sendAudio: jest.fn(), pause: jest.fn(), resume: jest.fn(), end: jest.fn() };
let capturedSessionArgs;

jest.mock('../src/palabraSession', () => ({
  createSession: jest.fn((args) => {
    capturedSessionArgs = args;
    return mockSession;
  }),
}));

const { createSession } = require('../src/palabraSession');
const { handleConnection, INBOUND_CHUNK_BYTES } = require('../src/stream/streamHandler');
const { registry, upsertLeg } = require('../src/stream/sessionStore');

describe('mediaStream', () => {
  const createFakeWs = () => {
    const handlers = {};
    return {
      OPEN: 1,
      readyState: 1,
      on: jest.fn((event, handler) => {
        handlers[event] = handler;
      }),
      send: jest.fn(),
      emit: (event, ...args) => handlers[event]?.(...args),
    };
  };

  const startEvent = ({
    callSid,
    streamSid,
    pairId,
    peerCallSid,
    playback,
    sourceLanguage,
    targetLanguage,
  }) =>
    JSON.stringify({
      event: 'start',
      start: {
        callSid,
        streamSid,
        customParameters: {
          pairId,
          peerCallSid,
          playback: playback || 'twilio',
          ...(sourceLanguage ? { sourceLanguage } : {}),
          ...(targetLanguage ? { targetLanguage } : {}),
        },
      },
    });

  const pairBothLegs = () => {
    const agentWs = createFakeWs();
    const clientWs = createFakeWs();
    const browserWs = createFakeWs();
    registry.registerPair('PAIR1', {
      agentCallSid: 'CA_AGENT',
      clientCallSid: 'CA_CLIENT',
      from: '+1',
      to: '+2',
    });
    handleConnection(agentWs);
    handleConnection(clientWs);

    agentWs.emit(
      'message',
      startEvent({
        callSid: 'CA_AGENT',
        streamSid: 'MZ_AGENT',
        pairId: 'PAIR1',
        peerCallSid: 'CA_CLIENT',
        playback: 'browser',
        sourceLanguage: 'en',
        targetLanguage: 'hi',
      })
    );
    clientWs.emit(
      'message',
      startEvent({
        callSid: 'CA_CLIENT',
        streamSid: 'MZ_CLIENT',
        pairId: 'PAIR1',
        peerCallSid: 'CA_AGENT',
        playback: 'twilio',
        sourceLanguage: 'hi',
        targetLanguage: 'en',
      })
    );

    upsertLeg({
      pairId: 'PAIR1',
      callSid: 'CA_AGENT',
      peerCallSid: 'CA_CLIENT',
      playback: 'browser',
      browserWs,
    });

    return { agentWs, clientWs, browserWs };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    registry.removePair('PAIR1');
  });

  afterEach(() => {
    registry.removePair('PAIR1');
  });

  it('creates a Palabra session from TwiML language params on start', () => {
    const ws = createFakeWs();
    handleConnection(ws);

    ws.emit(
      'message',
      startEvent({
        callSid: 'CA_AGENT',
        streamSid: 'MZ1',
        pairId: 'PAIR1',
        peerCallSid: 'CA_CLIENT',
        playback: 'browser',
        sourceLanguage: 'en',
        targetLanguage: 'hi',
      })
    );

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(capturedSessionArgs).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'hi' });
    expect(registry.get('CA_AGENT').session).toBe(mockSession);
    expect(registry.get('CA_AGENT').playback).toBe('browser');
  });

  it('ignores a start message without pairId/peerCallSid', () => {
    const ws = createFakeWs();
    handleConnection(ws);
    ws.emit(
      'message',
      JSON.stringify({ event: 'start', start: { callSid: 'CA_UNKNOWN', streamSid: 'MZ1' } })
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it('forwards inbound mic to Palabra only after both legs are live', () => {
    const { agentWs } = pairBothLegs();
    mockSession.sendAudio.mockClear();

    const fullChunkPayload = Buffer.alloc(INBOUND_CHUNK_BYTES, 0xff).toString('base64');
    agentWs.emit(
      'message',
      JSON.stringify({ event: 'media', media: { track: 'inbound', payload: fullChunkPayload } })
    );
    expect(mockSession.sendAudio).toHaveBeenCalledTimes(1);
  });

  it('sends agent translation to client Twilio media, never onto agent Twilio WS', () => {
    const { agentWs, clientWs, browserWs } = pairBothLegs();

    const agentOutput = createSession.mock.calls[0][0].onOutputAudio;
    agentOutput({
      transcriptionId: 'utt-1',
      base64Audio: Buffer.alloc(320, 0).toString('base64'),
      lastChunk: false,
    });

    expect(clientWs.send).toHaveBeenCalled();
    expect(agentWs.send).not.toHaveBeenCalled();
    expect(browserWs.send).not.toHaveBeenCalled();
    const media = clientWs.send.mock.calls
      .map(([raw]) => JSON.parse(raw))
      .filter((m) => m.event === 'media');
    expect(media[0].streamSid).toBe('MZ_CLIENT');
  });

  it('sends client translation to browser playback WS, never onto agent Twilio WS', () => {
    const { agentWs, clientWs, browserWs } = pairBothLegs();

    const clientOutput = createSession.mock.calls[1][0].onOutputAudio;
    clientOutput({
      transcriptionId: 'utt-2',
      base64Audio: Buffer.alloc(320, 0).toString('base64'),
      lastChunk: false,
    });

    expect(browserWs.send).toHaveBeenCalled();
    expect(agentWs.send).not.toHaveBeenCalled();
    expect(clientWs.send).not.toHaveBeenCalled();
    const msg = JSON.parse(browserWs.send.mock.calls[0][0]);
    expect(msg).toMatchObject({ event: 'audio', format: 'mulaw', sampleRate: 8000 });
    expect(msg.payload).toBeTruthy();
  });

  it('does not feed mic to Palabra until peer leg is live', () => {
    const agentWs = createFakeWs();
    const clientWs = createFakeWs();
    registry.registerPair('PAIR1', { agentCallSid: 'CA_AGENT', clientCallSid: 'CA_CLIENT' });
    handleConnection(agentWs);
    handleConnection(clientWs);

    agentWs.emit(
      'message',
      startEvent({
        callSid: 'CA_AGENT',
        streamSid: 'MZ_AGENT',
        pairId: 'PAIR1',
        peerCallSid: 'CA_CLIENT',
        playback: 'browser',
        sourceLanguage: 'en',
        targetLanguage: 'hi',
      })
    );

    const fullChunkPayload = Buffer.alloc(INBOUND_CHUNK_BYTES, 0xff).toString('base64');
    agentWs.emit(
      'message',
      JSON.stringify({ event: 'media', media: { track: 'inbound', payload: fullChunkPayload } })
    );
    expect(mockSession.sendAudio).not.toHaveBeenCalled();
    expect(agentWs.send).not.toHaveBeenCalled();
  });

  it('hangs up the peer leg when one media stream disconnects', () => {
    const { agentWs, clientWs } = pairBothLegs();

    clientWs.emit('close');

    expect(mockCalls).toHaveBeenCalledWith('CA_AGENT');
    expect(mockUpdate).toHaveBeenCalledWith({ status: 'completed' });
    expect(registry.getPair('PAIR1')).toBeUndefined();
    expect(agentWs.send).not.toHaveBeenCalled();
  });
});
