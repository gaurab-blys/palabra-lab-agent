const mockUpdate = jest.fn();
const mockCreate = jest.fn();
const mockCalls = Object.assign(
  jest.fn(() => ({ update: mockUpdate })),
  {
    create: (...args) => mockCreate(...args),
  }
);

jest.mock('../src/twilioClient', () => ({
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
const { handleConnection, INBOUND_CHUNK_BYTES } = require('../src/mediaStream');
const { registry } = require('../src/pairRegistry');

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

  const startEvent = ({ callSid, streamSid, pairId, role }) =>
    JSON.stringify({
      event: 'start',
      start: {
        callSid,
        streamSid,
        customParameters: { pairId, role },
      },
    });

  beforeEach(() => {
    jest.clearAllMocks();
    registry.removePair('PAIR1');
  });

  afterEach(() => {
    registry.removePair('PAIR1');
  });

  it('creates a Palabra session using the agent language pair on Twilio start', () => {
    const ws = createFakeWs();
    handleConnection(ws);

    ws.emit(
      'message',
      startEvent({ callSid: 'CA_AGENT', streamSid: 'MZ1', pairId: 'PAIR1', role: 'agent' })
    );

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(capturedSessionArgs).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'hi' });
    expect(registry.get('CA_AGENT').session).toBe(mockSession);
  });

  it('resolves role from CallSid when customParameters disagree', () => {
    const ws = createFakeWs();
    handleConnection(ws);
    registry.registerPair('PAIR1', { agentCallSid: 'CA_AGENT', clientCallSid: 'CA_CLIENT' });
    ws.emit(
      'message',
      startEvent({
        callSid: 'CA_AGENT',
        streamSid: 'MZ1',
        pairId: 'PAIR1',
        role: 'client',
      })
    );

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(capturedSessionArgs).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'hi' });
  });

  it('ignores a start message without pairId/role', () => {
    const ws = createFakeWs();
    handleConnection(ws);

    ws.emit(
      'message',
      JSON.stringify({ event: 'start', start: { callSid: 'CA_UNKNOWN', streamSid: 'MZ1' } })
    );

    expect(createSession).not.toHaveBeenCalled();
  });

  it('forwards agent inbound (bidirectional stream mic) to Palabra', () => {
    const ws = createFakeWs();
    handleConnection(ws);
    ws.emit(
      'message',
      startEvent({ callSid: 'CA_AGENT', streamSid: 'MZ1', pairId: 'PAIR1', role: 'agent' })
    );

    const fullChunkPayload = Buffer.alloc(INBOUND_CHUNK_BYTES, 0xff).toString('base64');
    ws.emit(
      'message',
      JSON.stringify({ event: 'media', media: { track: 'inbound', payload: fullChunkPayload } })
    );
    expect(mockSession.sendAudio).toHaveBeenCalledTimes(1);
    expect(capturedSessionArgs).toMatchObject({ sourceLanguage: 'en', targetLanguage: 'hi' });
  });

  it('switches agent mic to outbound when Voice SDK starts sending it', () => {
    const ws = createFakeWs();
    handleConnection(ws);
    ws.emit(
      'message',
      startEvent({ callSid: 'CA_AGENT', streamSid: 'MZ1', pairId: 'PAIR1', role: 'agent' })
    );

    const inboundPayload = Buffer.alloc(INBOUND_CHUNK_BYTES, 0xaa).toString('base64');
    ws.emit(
      'message',
      JSON.stringify({ event: 'media', media: { track: 'inbound', payload: inboundPayload } })
    );
    expect(mockSession.sendAudio).toHaveBeenCalledTimes(1);
    mockSession.sendAudio.mockClear();

    const outboundPayload = Buffer.alloc(INBOUND_CHUNK_BYTES, 0xff).toString('base64');
    ws.emit(
      'message',
      JSON.stringify({ event: 'media', media: { track: 'outbound', payload: outboundPayload } })
    );
    expect(mockSession.sendAudio).toHaveBeenCalledTimes(1);

    mockSession.sendAudio.mockClear();
    ws.emit(
      'message',
      JSON.stringify({ event: 'media', media: { track: 'inbound', payload: inboundPayload } })
    );
    expect(mockSession.sendAudio).not.toHaveBeenCalled();
  });

  it('buffers client inbound media and forwards once a full chunk is accumulated', () => {
    const ws = createFakeWs();
    handleConnection(ws);
    ws.emit(
      'message',
      startEvent({ callSid: 'CA_CLIENT', streamSid: 'MZ1', pairId: 'PAIR1', role: 'client' })
    );

    const smallPayload = Buffer.alloc(10, 0xff).toString('base64');
    ws.emit(
      'message',
      JSON.stringify({ event: 'media', media: { track: 'inbound', payload: smallPayload } })
    );
    expect(mockSession.sendAudio).not.toHaveBeenCalled();

    const fullChunkPayload = Buffer.alloc(INBOUND_CHUNK_BYTES, 0xff).toString('base64');
    ws.emit(
      'message',
      JSON.stringify({ event: 'media', media: { track: 'inbound', payload: fullChunkPayload } })
    );
    expect(mockSession.sendAudio).toHaveBeenCalledTimes(1);
    expect(capturedSessionArgs).toMatchObject({ sourceLanguage: 'hi', targetLanguage: 'en' });
  });

  it('forwards Twilio Client outbound-tagged mic audio on the agent leg', () => {
    const ws = createFakeWs();
    handleConnection(ws);
    ws.emit(
      'message',
      startEvent({ callSid: 'CA_AGENT', streamSid: 'MZ1', pairId: 'PAIR1', role: 'agent' })
    );

    const fullChunkPayload = Buffer.alloc(INBOUND_CHUNK_BYTES, 0xff).toString('base64');
    ws.emit(
      'message',
      JSON.stringify({ event: 'media', media: { track: 'outbound', payload: fullChunkPayload } })
    );
    expect(mockSession.sendAudio).toHaveBeenCalledTimes(1);
  });

  it('sends Palabra TTS to the peer even when OPEN is not copied onto the socket instance', () => {
    const agentWs = createFakeWs();
    const clientWs = createFakeWs();
    delete clientWs.OPEN;
    registry.registerPair('PAIR1', { agentCallSid: 'CA_AGENT', clientCallSid: 'CA_CLIENT' });
    handleConnection(agentWs);
    handleConnection(clientWs);

    agentWs.emit(
      'message',
      startEvent({ callSid: 'CA_AGENT', streamSid: 'MZ_AGENT', pairId: 'PAIR1', role: 'agent' })
    );
    clientWs.emit(
      'message',
      startEvent({ callSid: 'CA_CLIENT', streamSid: 'MZ_CLIENT', pairId: 'PAIR1', role: 'client' })
    );

    const agentOutput = createSession.mock.calls[0][0].onOutputAudio;
    const base64Audio = Buffer.alloc(320, 0).toString('base64');
    agentOutput({ transcriptionId: 'utt-1', base64Audio, lastChunk: false });

    expect(clientWs.send).toHaveBeenCalled();
    expect(agentWs.send).not.toHaveBeenCalled();
  });

  it('buffers TTS until the peer leg connects, then flushes on pairing', () => {
    const agentWs = createFakeWs();
    const clientWs = createFakeWs();
    registry.registerPair('PAIR1', { agentCallSid: 'CA_AGENT', clientCallSid: 'CA_CLIENT' });
    handleConnection(agentWs);
    handleConnection(clientWs);

    agentWs.emit(
      'message',
      startEvent({ callSid: 'CA_AGENT', streamSid: 'MZ_AGENT', pairId: 'PAIR1', role: 'agent' })
    );

    const agentOutput = createSession.mock.calls[0][0].onOutputAudio;
    const base64Audio = Buffer.alloc(320, 0).toString('base64');
    agentOutput({ transcriptionId: 'utt-early', base64Audio, lastChunk: false });

    expect(clientWs.send).not.toHaveBeenCalled();

    clientWs.emit(
      'message',
      startEvent({ callSid: 'CA_CLIENT', streamSid: 'MZ_CLIENT', pairId: 'PAIR1', role: 'client' })
    );

    expect(clientWs.send).toHaveBeenCalled();
    expect(agentWs.send).not.toHaveBeenCalled();
  });

  it('does not feed agent outbound TTS echo back into Palabra while playback is suppressed', () => {
    const agentWs = createFakeWs();
    const clientWs = createFakeWs();
    registry.registerPair('PAIR1', { agentCallSid: 'CA_AGENT', clientCallSid: 'CA_CLIENT' });
    handleConnection(agentWs);
    handleConnection(clientWs);

    agentWs.emit(
      'message',
      startEvent({ callSid: 'CA_AGENT', streamSid: 'MZ_AGENT', pairId: 'PAIR1', role: 'agent' })
    );
    clientWs.emit(
      'message',
      startEvent({ callSid: 'CA_CLIENT', streamSid: 'MZ_CLIENT', pairId: 'PAIR1', role: 'client' })
    );

    const clientOutput = createSession.mock.calls[1][0].onOutputAudio;
    const base64Audio = Buffer.alloc(320, 0).toString('base64');
    clientOutput({ transcriptionId: 'utt-2', base64Audio, lastChunk: false });

    mockSession.sendAudio.mockClear();
    const echoPayload = Buffer.alloc(INBOUND_CHUNK_BYTES, 0xaa).toString('base64');
    agentWs.emit(
      'message',
      JSON.stringify({ event: 'media', media: { track: 'outbound', payload: echoPayload } })
    );

    expect(mockSession.sendAudio).not.toHaveBeenCalled();
  });

  it('ends the Palabra session and clears the pair on close', () => {
    const ws = createFakeWs();
    handleConnection(ws);
    ws.emit(
      'message',
      startEvent({ callSid: 'CA_AGENT', streamSid: 'MZ1', pairId: 'PAIR1', role: 'agent' })
    );

    ws.emit('close');

    expect(mockSession.end).toHaveBeenCalled();
    expect(registry.getPair('PAIR1')).toBeUndefined();
  });
});
