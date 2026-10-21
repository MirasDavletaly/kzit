# KZIT - 1:1 video call with AI interpreter (Italian <-> Kazakh)

Source code of the prototype running at https://test.horizonaether.com/kzit/

## What it does
- 1:1 video call in the browser (WebRTC, peer-to-peer), protected by a 6-digit PIN.
- Each participant chooses their language (Italian or Kazakh).
- The listener hears only the translated voice (the original voice of the other participant is muted) and sees subtitles in both languages.
- Two translation engines, chosen when the room is created:
  - **live** (default when `GEMINI_API_KEY` is set): Gemini Live Translate (`gemini-3.5-live-translate-preview`), speech-to-speech streaming. While someone speaks, the browser streams 16 kHz PCM in 100 ms chunks over the WebSocket (plus 3.5 s after the last voice: the model translates at the pace of the incoming audio and needs that tail to finish the sentence). The server keeps one Gemini session per speaker and relays translated text fragments and 24 kHz PCM (silence dropped) to the listener. The translation runs about 3 s behind the speaker, while they are still talking.
  - **classic**: the browser cuts the voice into sentences (pauses) and sends each one as a WAV; the server calls OpenRouter twice per sentence (audio LLM for transcript + translation, then TTS). The translation starts 3-4 s after the end of each sentence. Use it with `?engine=classic` on the page that creates the room, or `ENGINE=classic`.

## Structure
- `server.js` - Node.js server (Express + ws): rooms and PIN, WebRTC signalling over WebSocket, translation pipeline, logging, log viewer API.
- `public/index.html`, `public/app.js` - client (no build step, plain JavaScript): UI, WebRTC, VAD, subtitles, playback of the translated voice, client-side event logging.
- `log.html` - log viewer (served at `/kzit/log?k=LOG_KEY`).
- `.env.example` - configuration template.

There is no build step: the files in this archive are the original source that runs in production.

## Requirements
- Node.js 18+ (tested on Node 22)
- An OpenRouter API key
- HTTPS in front of the app (browsers allow camera/microphone only on HTTPS)

## Run
```
cp .env.example .env      # set OPENROUTER_API_KEY and LOG_KEY
npm install
node server.js            # listens on 127.0.0.1:3121, base path /kzit
```

## Synology (Container Manager) + Tailscale
`docker-compose.yml` runs KZIT as a separate machine `kzit` in the tailnet. The `tailscale/tailscale` container has its own state and userspace networking, so it does not touch the NAS's own Tailscale or other machines. The app container lives inside its network and opens no ports on the NAS. `tailscale serve` provides HTTPS with a valid certificate, which browsers require for camera and microphone.

1. Tailscale admin console: DNS → enable MagicDNS and HTTPS Certificates; Settings → Keys → generate an auth key (one-off is enough). Funnel is on in `tailscale/serve.json` (`AllowFunnel`), so the address is public: the tailnet policy must give the machine the `funnel` attribute (`"nodeAttrs": [{"target": ["autogroup:member"], "attr": ["funnel"]}]`, present in the default policy).
2. Copy the project to the NAS, e.g. `/volume1/docker/kzit` (`kzit-synology.zip` has the needed files), plus `.env` with the app keys, `CREATE_KEY`, a non-default `LOG_KEY` and `TS_AUTHKEY=tskey-auth-...`.
3. Container Manager → Project → Create → path `/volume1/docker/kzit`, source "use existing docker-compose.yml" → build and start.
4. Tailscale admin → Machines → `kzit` (or `kzit-1` if the name is taken) → disable key expiry, otherwise it drops off the tailnet after the key lifetime.
5. Rooms are created from `https://kzit.<tailnet>.ts.net/kzit/?key=<CREATE_KEY>`; the other participant only needs the address and the PIN (the page shows a link with the PIN after the room is created).

## Local test from a phone (same Wi-Fi)
Browsers allow camera/microphone only on HTTPS, so `tools/https-proxy.js` plays the role of Apache with a self-signed certificate:
```
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=kzit-local" -addext "subjectAltName=IP:<PC IP>,IP:127.0.0.1,DNS:localhost" -keyout tools/.dev-cert/key.pem -out tools/.dev-cert/cert.pem
node server.js
node tools/https-proxy.js        # prints https://<PC IP>:3443/kzit/
```
On the phone open the printed address and accept the certificate warning; on the PC use http://localhost:3121/kzit/.

## Reverse proxy (Apache example)
```
RewriteEngine On
RewriteCond %{HTTP:Upgrade} websocket [NC]
RewriteCond %{HTTP:Connection} upgrade [NC]
RewriteRule ^/kzit/ws(.*) ws://127.0.0.1:3121/kzit/ws$1 [P,L]
ProxyPass        "/kzit" "http://127.0.0.1:3121/kzit"
ProxyPassReverse "/kzit" "http://127.0.0.1:3121/kzit"
```

## Configuration (.env)
| Variable | Default | Meaning |
|---|---|---|
| GEMINI_API_KEY | - | Google Gemini API key for the live engine (server side only) |
| ENGINE | live if GEMINI_API_KEY is set | default engine for new rooms: `live` or `classic` |
| MODEL_LIVE | gemini-3.5-live-translate-preview | streaming speech-to-speech model (live engine) |
| OPENROUTER_API_KEY | - | OpenRouter key for the classic engine (server side only, never sent to the browser) |
| PORT | 3121 | local port |
| MODEL_TRANSLATE | google/gemini-3.5-flash-lite | audio -> transcript + translation |
| MODEL_TTS | google/gemini-3.8-flash-lite-tts | text -> speech (PCM 24 kHz, wrapped as WAV) |
| VOICE_IT / VOICE_KK | Charon / Kore | TTS voices |
| LOG_KEY | - | key for the log viewer |
| LOG_AUDIO_DAYS | 14 | retention of saved audio clips |

## Logging
- Server events are written to `logs/kzit-YYYY-MM-DD.jsonl`; audio of every sentence (input and synthesized output) to `logs/audio/`.
- The browser sends its own events (permissions, devices, WebRTC states and stats, VAD segments, playback, errors) to `/kzit/api/clog`.
- Recorded voices are personal data: inform participants before use.

## Gemini Live Translate test
`tools/live-translate-test.js` streams recorded phrases to `gemini-3.5-live-translate-preview` (streaming speech-to-speech translation) at real-time pace, in 100 ms chunks like a microphone, and measures the delay. It is used to decide whether to replace the sentence-by-sentence pipeline.
```
# set GEMINI_API_KEY in .env, then
npm install
node tools/live-translate-test.js --to kk logs/audio/2026-10-20/*_it_in.wav   # Italian -> Kazakh
node tools/live-translate-test.js --to it logs/audio/2026-10-20/*_kk_in.wav   # Kazakh -> Italian
```
- Input: WAV 16 kHz mono 16-bit (like the clips saved in `logs/audio/`); other formats (phone recordings, mp3, m4a) need ffmpeg.
- Output in `live-test-out/`: `<name>.<lang>.wav` (translation only), `<name>.<lang>.timeline.wav` (original at 30% plus the translation placed when it arrives, to hear the real delay), `report-*.json` (transcripts and timings).
- `start lag`: seconds from the start of speech to the first translated audio. `end lag`: seconds from the end of speech to the end of the translated audio.

## Known limits
- Live engine: preview model. It may misdetect Kazakh as Russian (there is no way to force the source language) and, translating before the sentence ends, it can commit to a wrong word or number. Audio of live calls is not saved, only the text.
- Classic engine: consecutive (sentence by sentence) interpretation, not word by word.
- While the translated voice is playing, the listener's microphone is not sent for translation (prevents re-translating the interpreter). Headphones recommended.
- No TURN server: on very restrictive corporate networks the peer-to-peer video may not connect.
- Rooms are kept in memory: a server restart closes open rooms.
