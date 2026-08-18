# Palabra + Twilio outbound test lab

Standalone harness for testing real-time voice translation between two phone legs using **Twilio Media Streams** and **Palabra AI speech-to-speech**.

This mirrors the outbound Connect/Stream path from the blysnode staging spike (`src/api/v3/services/voiceTranslation/`) without the Blys conference stack, NAP, or database.

## Architecture

```
place-call.js  →  Twilio (agent leg)  →  POST /api/v2/webhook/twilio/voice
                                              ↓
                                    dials client leg + returns agent TwiML
                                              ↓
                         both legs → WS /api/v2/webhook/twilio/voice/palabra-stream
                                              ↓
                         agent (en→hi) + client (hi→en) Palabra sessions
                                              ↓
                         translated TTS relayed to peer via Twilio media
```

## Quick start

### 1. Install

```bash
cd palabra-twilio-lab
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Description |
|----------|-------------|
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Verified Twilio caller ID |
| `PALABRA_API_KEY` | Palabra streaming API key |
| `WEBHOOK_BASE_URL` | Public HTTPS URL (ngrok) — no trailing slash |

### 2. Start ngrok + server

```bash
# Terminal 1
ngrok http 4000

# Terminal 2 — set WEBHOOK_BASE_URL in .env to the ngrok HTTPS URL
npm run dev
```

Verify: `curl http://localhost:4000/health`

### 3. Place a test call (no NAP — use the lab browser agent)

**Caller number** = `TWILIO_FROM_NUMBER` (e.g. `+19189194048`)  
**Client number** = customer phone (e.g. `+9779702005057`)

Configure your Twilio **TwiML App** voice URL to:
`https://YOUR-NGROK/api/v2/webhook/twilio/voice`

```bash
npm run call -- --to +977CLIENT_PHONE
# Opens instructions + agent URL

# Or open directly after npm run dev:
# http://localhost:4000/agent?caller=+19189194048&client=+977...
```

1. `ngrok http 4000` → set `WEBHOOK_BASE_URL` in `.env`
2. `npm run dev`
3. Open **http://localhost:4000/agent** → click **Call client**
4. Client phone rings; speak in the browser (English → Hindi by default)

**Connectivity test** (client rings, no Palabra):
```bash
npm run call -- --to +977CLIENT --test-ring
```
- Speak English on the agent leg, Hindi on the client leg (default language pair)

## What to watch in logs

| Log prefix | Meaning |
|------------|---------|
| `[outbound] stream pair started` | Client leg dialed; pair registered |
| `[stream] media stream connected` | Twilio WS connected for one leg |
| `[stream] legs paired` | Both agent + client streams active |
| `[palabra] translated text` | ASR + translation text from Palabra |
| `[latency] palabra` | `palabraMs` and `e2eMs` per utterance |
| `[stream] peer not ready, dropping TTS` | Peer leg not connected yet — usually transient |
| `[palabra] ws closed, reconnecting` | Palabra socket dropped; retry with backoff |
| `[palabra] ws closed, retries exhausted` | Translation off; **Twilio call stays up** |

Example latency line:

```
[2026-08-17T...] INFO [latency] palabra {"callSid":"CA...","direction":"en->hi","palabraMs":412,"e2eMs":415}
```

## Tuning knobs

Edit `.env` or Palabra session config in `src/palabraSession.js`:

| Knob | Default | Effect |
|------|---------|--------|
| `AGENT_SOURCE_LANG` / `AGENT_TARGET_LANG` | `en` / `hi` | Agent leg translation direction |
| `CLIENT_SOURCE_LANG` / `CLIENT_TARGET_LANG` | `hi` / `en` | Client leg translation direction |
| `PALABRA_AUDIO_FORMAT.chunkMs` in config | `320` | μ-law buffer before sending to Palabra |
| `segment_confirmation_silence_threshold` | `0.5` | Lower = faster TTS start, may cut phrases |
| `translate_partial_transcriptions` | `false` | `true` = faster but choppier TTS |

## Interrupt Palabra WebSocket (TC-06)

If Palabra’s streaming socket drops mid-call, the lab **reconnects** (500ms → 1.5s → 4s, max 3 attempts) and re-sends `set_task`. Audio is dropped until `current_task` again. After retries are exhausted, translation stops and the **Twilio call stays up** (`[stream] session error (call continues)`).

This is **not** in blysnode today (`palabraWs.js` close handler only stops polling). The lab is the place to prove the behavior before porting.

### Live QA

1. Place a call from `/agent` and wait until both legs are paired and you hear translation.
2. On the agent page, use **Interrupt Palabra** (drops the agent Palabra socket; call stays up). Or from a terminal:

```bash
# Drop both legs (or ?role=agent / ?role=client)
curl -X POST "http://localhost:4000/debug/drop-palabra?role=both"
```

**Mute mic** on `/agent` mutes the browser microphone via the Twilio Voice SDK — Palabra should stop receiving English until you unmute.

3. Watch logs:

- **Pass (reconnect):** `[palabra] ws closed, reconnecting` → `[palabra] ws open` → `[palabra] task ready` → `[palabra] translated text` resumes.
- **Pass (fail open):** `[palabra] ws closed, retries exhausted — call continues without translation` — phones stay connected, no crash. Repeat the curl 4 times quickly to exhaust retries.

Do **not** hang up from `/agent` during this test — that calls `end()` and must **not** reconnect.

## Tests

```bash
npm test
```

Unit tests mock Twilio and Palabra — no live API calls.

## Mapping to blysnode staging

| Lab file | blysnode source |
|----------|-----------------|
| `src/audio.js` | `voiceTranslation/audio.js` |
| `src/palabraSession.js` | `voiceTranslation/palabraWs.js` |
| `src/stream/sessionStore.js` | `voiceTranslation/palabra.js` (registry section) |
| `src/stream/streamHandler.js` | `voiceTranslation/palabra.js` (`handleConnection`) |
| `src/voice/twiml.js` | `voiceTranslation/palabra.js` (`buildCallTwiml`) |
| `src/voice/outboundCall.js` | `voiceTranslation/palabra.js` (outbound dial) |
| `src/routes/voice.js` | `twilioWebhook.service.js` outbound hook |

**Intentionally omitted** (out of scope):

- Inbound conference + `startTranslation` redirect
- Hold/pause/resume/transfer
- DeepL stub strategy
- Blys DB call logs and NAP socket events

## Troubleshooting

**No translation heard**

- Confirm `PALABRA_API_KEY` is set and `[palabra] task ready` appears in logs
- Check both phones answered and `[stream] legs paired` logged
- Ensure `WEBHOOK_BASE_URL` uses HTTPS ngrok URL (Twilio requires public WSS for media streams)

**Client never connects**

- 35s timeout hangs up both legs if client stream doesn't start
- Check client phone number format (`+1...`)

**Echo or double audio**

- Agent outbound track suppression is enabled — see `mediaStream.js`
- If using Twilio Client SDK as agent, outbound-tagged mic is supported
