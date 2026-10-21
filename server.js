// KZIT - video call 1:1 con PIN e interprete AI italiano <-> kazako via OpenRouter
// Servito sotto https://test.horizonaether.com/kzit/ (Apache -> 127.0.0.1:PORT)
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

// ---------- config (.env senza dipendenze) ----------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const PORT = parseInt(process.env.PORT || '3121', 10);
const KEY = process.env.OPENROUTER_API_KEY || '';
const MODEL_TRANSLATE = process.env.MODEL_TRANSLATE || 'google/gemini-3.8-flash';
const MODEL_TTS = process.env.MODEL_TTS || 'google/gemini-3.8-flash-tts';
const BASE = '/kzit';
const OR = 'https://openrouter.ai/api/v1';
const LANG = { it: 'italiano (Italian)', kk: 'kazako (Kazakh, Cyrillic script)' };
const VOICE = { it: process.env.VOICE_IT || 'Charon', kk: process.env.VOICE_KK || 'Kore' };
// motore "live": Gemini Live Translate, voce -> voce in streaming mentre si parla; "classic": frase per frase via OpenRouter
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const MODEL_LIVE = process.env.MODEL_LIVE || 'gemini-3.5-live-translate-preview';
const ENGINE = process.env.ENGINE === 'classic' || !GEMINI_KEY ? 'classic' : 'live';
const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=';
// se impostata, serve per creare una stanza (?key=... nel link); per entrare basta il PIN
const CREATE_KEY = process.env.CREATE_KEY || '';

// ---------- log (JSONL giornaliero + audio) ----------
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_KEY = process.env.LOG_KEY || '';
const LOG_AUDIO_DAYS = parseInt(process.env.LOG_AUDIO_DAYS || '14', 10);
fs.mkdirSync(path.join(LOG_DIR, 'audio'), { recursive: true });
const day = () => new Date().toISOString().slice(0, 10);
function L(ev, o) {
  const rec = Object.assign({ t: new Date().toISOString(), ev }, o || {});
  try { fs.appendFileSync(path.join(LOG_DIR, 'kzit-' + day() + '.jsonl'), JSON.stringify(rec) + '\n'); } catch (e) {}
  if (!/^(client:level|ws:ping)$/.test(ev)) console.log(rec.t, ev, JSON.stringify(o || {}).slice(0, 220));
}
function saveAudio(name, buf) {
  try {
    const d = path.join(LOG_DIR, 'audio', day()); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, name), buf); return day() + '/' + name;
  } catch (e) { return null; }
}
setInterval(() => { // pulizia audio vecchi
  try {
    const base = path.join(LOG_DIR, 'audio'), lim = Date.now() - LOG_AUDIO_DAYS * 86400000;
    for (const d of fs.readdirSync(base)) if (new Date(d).getTime() < lim) fs.rmSync(path.join(base, d), { recursive: true, force: true });
  } catch (e) {}
}, 6 * 3600 * 1000);
const who = (req) => ({ ip: req.ip, ua: (req.get('user-agent') || '').slice(0, 160) });

// ---------- stanze ----------
const rooms = new Map();          // pin -> { pin, created, last, members: Map(token -> member) }
const tokens = new Map();         // token -> { pin }
const fails = new Map();          // ip -> { n, t }
const ROOM_TTL = 4 * 3600 * 1000;

function newPin() {
  for (let i = 0; i < 50; i++) {
    const p = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    if (!rooms.has(p)) return p;
  }
  throw new Error('no pin');
}
function member(token) {
  const t = tokens.get(token); if (!t) return null;
  const room = rooms.get(t.pin); if (!room) return null;
  const m = room.members.get(token); if (!m) return null;
  return { room, m };
}
function other(room, token) {
  for (const [t, m] of room.members) if (t !== token) return m;
  return null;
}
function send(m, obj) {
  if (m && m.ws && m.ws.readyState === 1) m.ws.send(JSON.stringify(obj));
}
function tooManyFails(ip) {
  const f = fails.get(ip);
  return f && Date.now() - f.t < 10 * 60 * 1000 && f.n >= 10;
}
function addFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.t > 10 * 60 * 1000) fails.set(ip, { n: 1, t: Date.now() });
  else f.n++;
}
setInterval(() => {
  const now = Date.now();
  for (const [pin, r] of rooms) {
    if (now - r.last > ROOM_TTL) {
      for (const [t, m] of r.members) { try { m.ws && m.ws.close(); } catch (e) {} tokens.delete(t); }
      rooms.delete(pin);
      L('room:expired', { pin });
    }
  }
}, 60 * 1000);

function addMember(room, lang, name) {
  const token = crypto.randomBytes(24).toString('hex');
  room.members.set(token, { token, lang, name: (name || '').slice(0, 40), ws: null, chain: Promise.resolve(), busy: 0 });
  tokens.set(token, { pin: room.pin });
  room.last = Date.now();
  return token;
}

function removeMember(room, token, why) {
  const m = room.members.get(token); if (!m) return;
  liveClose(m);
  try { m.ws && m.ws.close(); } catch (e) {}
  room.members.delete(token); tokens.delete(token);
  L('room:member-removed', { pin: room.pin, member: token.slice(0, 8), why });
}

// ---------- OpenRouter ----------
async function orFetch(url, body, asBuffer) {
  const r = await fetch(OR + url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + KEY,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://test.horizonaether.com/kzit/',
      'X-Title': 'KZIT interprete IT-KK'
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('OpenRouter ' + url + ' ' + r.status + ' ' + t.slice(0, 300));
  }
  return asBuffer ? Buffer.from(await r.arrayBuffer()) : r.json();
}

async function listenAndTranslate(wavB64, from, to, context) {
  const sys =
    'You are a professional simultaneous interpreter between Italian and Kazakh at a business meeting. ' +
    'You receive a short audio clip spoken in ' + LANG[from] + '. ' +
    'Return ONLY a JSON object: {"transcript": "<exact transcription in the source language>", "translation": "<faithful, natural translation into ' + LANG[to] + '>"}. ' +
    'Keep names, numbers and technical terms accurate. Do not add comments. ' +
    'Kazakh must be written in Cyrillic. ' +
    'If the clip contains no intelligible speech (silence, noise, coughs), return {"transcript": "", "translation": ""}.';
  const msgs = [{ role: 'system', content: sys }];
  if (context) msgs.push({ role: 'user', content: 'Previous lines of the conversation, for context only (do not translate them):\n' + context });
  msgs.push({
    role: 'user',
    content: [
      { type: 'text', text: 'Transcribe and translate this clip.' },
      { type: 'input_audio', input_audio: { data: wavB64, format: 'wav' } }
    ]
  });
  const j = await orFetch('/chat/completions', {
    model: MODEL_TRANSLATE,
    messages: msgs,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    usage: { include: true }
  });
  const usage = j.usage || null;
  let txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  if (Array.isArray(txt)) txt = txt.map(p => p.text || '').join('');
  const m = String(txt).match(/\{[\s\S]*\}/);
  let out = { transcript: '', translation: '' };
  try { out = JSON.parse(m ? m[0] : txt); } catch (e) { out.translation = String(txt).trim(); }
  return { transcript: String(out.transcript || '').trim(), translation: String(out.translation || '').trim(), raw: String(txt).slice(0, 2000), usage, model: j.model };
}

async function speak(text, lang) {
  // Gemini TTS restituisce PCM 16 bit mono 24 kHz: lo incapsulo in WAV per il browser
  const pcm = await orFetch('/audio/speech', {
    model: MODEL_TTS,
    input: text,
    voice: VOICE[lang] || 'Kore',
    response_format: 'pcm',
    instructions: lang === 'kk'
      ? 'Speak in Kazakh with natural Kazakh pronunciation, clear, at a brisk interpreting pace.'
      : 'Parla in italiano con pronuncia naturale, chiara, a ritmo sostenuto da interprete.'
  }, true);
  const rate = 24000, h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]).toString('base64');
}

// ---------- Gemini Live Translate ----------
// Una sessione per chi parla, verso la lingua dell'altro. Il browser manda PCM 16 kHz a blocchi da 100 ms solo mentre
// si parla (+3,5 s: il modello traduce al ritmo dell'audio in ingresso e senza coda non finisce la frase).
// Il modello risponde con ~3 s di ritardo: testo a pezzi + PCM 24 kHz continuo, silenzio compreso.
function liveTarget(room, m) {
  const p = other(room, m.token);
  return p ? p.lang : (m.lang === 'it' ? 'kk' : 'it');
}
function rms(pcm) {
  const n = pcm.length >> 1; let s = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; s += v * v; }
  return n ? Math.sqrt(s / n) : 0;
}
function liveText(room, m, kind, text) {
  const o = { type: 'live-text', kind, text };
  send(m, Object.assign({ who: 'self' }, o));
  send(other(room, m.token), Object.assign({ who: 'peer' }, o));
  L('live:text', { pin: room.pin, member: m.token.slice(0, 8), kind, text });
}
function liveOpen(room, m) {
  const mm = m.token.slice(0, 8);
  const s = { g: new WebSocket(LIVE_URL + encodeURIComponent(GEMINI_KEY)), to: liveTarget(room, m), ready: false, queue: [], t0: Date.now(), last: 0, burst: Date.now(), heard: false };
  m.live = s;
  s.g.on('open', () => s.g.send(JSON.stringify({
    setup: {
      model: 'models/' + MODEL_LIVE,
      generationConfig: { responseModalities: ['AUDIO'], translationConfig: { targetLanguageCode: s.to, echoTargetLanguage: false } },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    }
  })));
  s.g.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.setupComplete) {
      s.ready = true;
      L('live:open', { pin: room.pin, member: mm, from: m.lang, to: s.to, ms: Date.now() - s.t0, queued: s.queue.length });
      for (const b of s.queue) liveSend(s, b);
      s.queue = [];
      return;
    }
    const c = msg.serverContent; if (!c) return;
    if (c.inputTranscription && c.inputTranscription.text) liveText(room, m, 'orig', c.inputTranscription.text);
    if (c.outputTranscription && c.outputTranscription.text) liveText(room, m, 'trans', c.outputTranscription.text);
    for (const p of (c.modelTurn && c.modelTurn.parts) || []) {
      if (!p.inlineData || !p.inlineData.data) continue;
      const pcm = Buffer.from(p.inlineData.data, 'base64');
      if (rms(pcm) < 0.002) continue;                 // silenzio: non lo inoltro
      if (!s.heard) { s.heard = true; L('live:first-audio', { pin: room.pin, member: mm, ms: Date.now() - s.burst }); }
      const peer = other(room, m.token);
      if (peer && peer.ws && peer.ws.readyState === 1) peer.ws.send(pcm);   // binario: PCM 16 bit mono 24 kHz
    }
  });
  s.g.on('close', (code, reason) => {
    L('live:close', { pin: room.pin, member: mm, code, reason: String(reason || '').slice(0, 200), ready: s.ready });
    if (m.live === s) m.live = null;
  });
  s.g.on('error', e => L('live:error', { pin: room.pin, member: mm, error: e.message }));
}
function liveSend(s, buf) {
  if (s.g.readyState === 1) s.g.send(JSON.stringify({ realtimeInput: { audio: { data: buf.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
}
function liveClose(m) {
  const s = m.live; if (!s) return;
  m.live = null;
  try { s.g.close(); } catch (e) {}
}
function liveAudio(room, m, buf) {
  if (room.engine !== 'live' || buf.length > 32000) return;
  const now = Date.now();
  room.last = now;
  const to = liveTarget(room, m);
  if (to === m.lang) return;                          // stessa lingua: niente da tradurre
  if (m.live && m.live.to !== to) liveClose(m);       // l'altro è cambiato
  if (!m.live) liveOpen(room, m);
  const s = m.live;
  if (s.last && now - s.last > 1500) { s.burst = now; s.heard = false; }   // nuovo tratto di parlato
  s.last = now;
  if (s.ready) liveSend(s, buf); else if (s.queue.length < 100) s.queue.push(buf);
}
setInterval(() => {   // chiudo le sessioni ferme (il modello continua a mandare silenzio finché è aperta)
  const now = Date.now();
  for (const r of rooms.values()) for (const m of r.members.values()) if (m.live && now - (m.live.last || m.live.t0) > 60000) liveClose(m);
}, 10000);

// ---------- app ----------
const app = express();
app.set('trust proxy', 'loopback');   // solo il proxy locale (Apache, tailscale serve): X-Forwarded-For del client non conta
app.use(BASE + '/api', express.json({ limit: '20kb' }));

app.use((req, res, next) => (req.path === BASE || req.path === '/' ? res.redirect(BASE + '/') : next()));
app.use(BASE, express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: 0 }));

app.post(BASE + '/api/room', (req, res) => {
  const lang = req.body && req.body.lang === 'kk' ? 'kk' : 'it';
  if (CREATE_KEY && (req.body && req.body.key) !== CREATE_KEY) { L('room:bad-key', who(req)); return res.status(403).json({ error: 'key' }); }
  if (rooms.size > 50) return res.status(503).json({ error: 'busy' });
  const pin = newPin();
  const want = req.body && req.body.engine;
  const engine = want === 'classic' || (want === 'live' && GEMINI_KEY) ? want : ENGINE;
  const room = { pin, engine, created: Date.now(), last: Date.now(), members: new Map() };
  rooms.set(pin, room);
  const token = addMember(room, lang, req.body && req.body.name);
  L('room:create', Object.assign({ pin, lang, engine, member: token.slice(0, 8) }, who(req)));
  res.json({ pin, token, lang, engine, role: 'host' });
});

app.post(BASE + '/api/join', (req, res) => {
  const ip = req.ip;
  if (tooManyFails(ip)) return res.status(429).json({ error: 'too_many' });
  const pin = String((req.body && req.body.pin) || '').replace(/\D/g, '');
  const room = rooms.get(pin);
  if (tooManyFails(ip)) L('join:blocked', who(req));
  if (!room) { addFail(ip); L('join:bad-pin', Object.assign({ pin }, who(req))); return res.status(404).json({ error: 'pin' }); }
  if (room.members.size >= 2) {
    // posto occupato da chi è uscito o ha perso la connessione: lo libero e faccio entrare il nuovo
    let freed = null;
    for (const [t, mem] of room.members) if (!mem.ws) { freed = t; break; }
    if (!freed) { L('join:full', Object.assign({ pin }, who(req))); return res.status(409).json({ error: 'full' }); }
    removeMember(room, freed, 'replaced-on-join');
  }
  const lang = req.body.lang === 'kk' ? 'kk' : 'it';
  const token = addMember(room, lang, req.body.name);
  L('room:join', Object.assign({ pin, lang, member: token.slice(0, 8) }, who(req)));
  res.json({ pin, token, lang, engine: room.engine, role: 'guest' });
});

// un enunciato (WAV 16 kHz mono) -> trascrizione + traduzione + voce, consegnati nell'ordine
app.post(BASE + '/api/utt', express.raw({ type: 'audio/wav', limit: '3mb' }), (req, res) => {
  const found = member(req.get('x-token'));
  if (!found) { L('utt:bad-token', who(req)); return res.status(401).json({ error: 'token' }); }
  const { room, m } = found;
  const mm = m.token.slice(0, 8);
  if (!KEY) return res.status(500).json({ error: 'no_key' });
  if (!req.body || req.body.length < 2000) { L('utt:too-short', { pin: room.pin, member: mm, bytes: req.body ? req.body.length : 0 }); return res.json({ ok: true, skipped: true }); }
  if (m.busy > 6) { L('utt:backlog', { pin: room.pin, member: mm, busy: m.busy }); return res.status(429).json({ error: 'backlog' }); }
  room.last = Date.now();
  const peer = other(room, m.token);
  const from = m.lang, to = peer ? peer.lang : (m.lang === 'it' ? 'kk' : 'it');
  const id = crypto.randomBytes(6).toString('hex');
  const t0 = Date.now();
  const durMs = Math.round((req.body.length - 44) / 32);
  const inFile = saveAudio(room.pin + '_' + id + '_' + mm + '_' + from + '_in.wav', req.body);
  L('utt:in', { pin: room.pin, member: mm, id, from, to, bytes: req.body.length, audioMs: durMs, busy: m.busy, seq: req.get('x-seq') || null, file: inFile });
  m.busy++;
  send(m, { type: 'pending', id });
  const ctx = (room.history || []).slice(-4).join('\n');
  const job = (async () => {
    if (from === to) return { transcript: '', translation: '', same: true };
    const ta = Date.now();
    const tr = await listenAndTranslate(req.body.toString('base64'), from, to, ctx);
    tr.msTranslate = Date.now() - ta;
    L('utt:translated', { pin: room.pin, member: mm, id, ms: tr.msTranslate, model: tr.model || MODEL_TRANSLATE, transcript: tr.transcript, translation: tr.translation, raw: tr.translation ? undefined : tr.raw, usage: tr.usage });
    if (!tr.translation) return tr;
    const tb = Date.now();
    tr.audio = await speak(tr.translation, to);
    tr.msTts = Date.now() - tb;
    const outFile = saveAudio(room.pin + '_' + id + '_' + mm + '_' + to + '_tts.wav', Buffer.from(tr.audio, 'base64'));
    L('utt:tts', { pin: room.pin, member: mm, id, ms: tr.msTts, model: MODEL_TTS, bytes: Math.round(tr.audio.length * 0.75), file: outFile });
    return tr;
  })();
  job.catch(() => {});
  m.chain = m.chain.then(() => job).then(tr => {
    const ms = Date.now() - t0;
    if (!tr.transcript && !tr.translation) { L('utt:drop', { pin: room.pin, member: mm, id, same: !!tr.same, ms }); send(m, { type: 'drop', id }); return; }
    room.history = (room.history || []).concat([(from === 'it' ? 'IT: ' : 'KK: ') + tr.transcript]).slice(-8);
    const cap = { type: 'caption', id, from, to, orig: tr.transcript, trans: tr.translation, ms };
    send(m, Object.assign({ who: 'self' }, cap));
    const pp = other(room, m.token);
    send(pp, Object.assign({ who: 'peer', audio: tr.audio }, cap));
    L('utt:delivered', { pin: room.pin, member: mm, id, from, to, msTotal: ms, msTranslate: tr.msTranslate, msTts: tr.msTts, peerOnline: !!(pp && pp.ws) });
  }).catch(err => {
    L('utt:error', { pin: room.pin, member: mm, id, error: err.message });
    send(m, { type: 'error', id, message: 'Traduzione non riuscita' });
  }).finally(() => { m.busy--; });
  res.json({ ok: true, id });
});

// eventi dal browser (permessi, dispositivi, WebRTC, VAD, riproduzione)
app.post(BASE + '/api/clog', express.json({ limit: '64kb', type: ['application/json', 'text/plain'] }), (req, res) => {
  const found = member(req.get('x-token') || req.query.t);
  const evs = Array.isArray(req.body && req.body.events) ? req.body.events.slice(0, 100) : [];
  const base = found ? { pin: found.room.pin, member: found.m.token.slice(0, 8), lang: found.m.lang } : { member: 'anon' };
  for (const e of evs) L('client:' + String(e.ev || 'x').slice(0, 40), Object.assign({}, base, { ct: e.t, d: e.d }, e.ev === 'boot' ? who(req) : {}));
  res.json({ ok: true });
});

// visualizzatore log: /kzit/log?k=LOG_KEY  (&day=AAAA-MM-GG &pin=123456)
function okKey(req) { return LOG_KEY && req.query.k === LOG_KEY; }
app.get(BASE + '/api/logs', (req, res) => {
  if (!okKey(req)) return res.status(403).end();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : day();
  let lines = [];
  try { lines = fs.readFileSync(path.join(LOG_DIR, 'kzit-' + d + '.jsonl'), 'utf8').trim().split('\n'); } catch (e) {}
  let recs = lines.filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  if (req.query.pin) recs = recs.filter(r => r.pin === req.query.pin);
  if (req.query.nolevel) recs = recs.filter(r => r.ev !== 'client:level');
  res.json({ day: d, n: recs.length, recs: recs.slice(-3000) });
});
app.get(BASE + '/api/audio/:d/:f', (req, res) => {
  if (!okKey(req)) return res.status(403).end();
  const p = path.join(LOG_DIR, 'audio', path.basename(req.params.d), path.basename(req.params.f));
  if (!fs.existsSync(p)) return res.status(404).end();
  res.type('audio/wav').sendFile(p);
});
app.get(BASE + '/log', (req, res) => {
  if (!okKey(req)) return res.status(403).send('forbidden');
  res.sendFile(path.join(__dirname, 'log.html'));
});

// uscita volontaria: libera subito il posto
app.post(BASE + '/api/leave', express.json({ limit: '2kb', type: ['application/json', 'text/plain'] }), (req, res) => {
  const tok = req.get('x-token') || req.query.t;
  const found = member(tok);
  if (found) { send(other(found.room, tok), { type: 'peer-left' }); removeMember(found.room, tok, 'leave'); }
  res.json({ ok: true });
});

app.get(BASE + '/api/health', (req, res) => res.json({ ok: true, key: !!KEY, geminiKey: !!GEMINI_KEY, engine: ENGINE, rooms: rooms.size, models: { MODEL_TRANSLATE, MODEL_TTS, MODEL_LIVE } }));

// ---------- websocket: segnalazione WebRTC ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname !== BASE + '/ws') return socket.destroy();
  const found = member(u.searchParams.get('token'));
  if (!found) return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => {
    const { room, m } = found;
    if (m.ws) { try { m.ws.close(); } catch (e) {} }
    m.ws = ws;
    room.last = Date.now();
    const peer = other(room, m.token);
    const mm = m.token.slice(0, 8);
    L('ws:open', Object.assign({ pin: room.pin, member: mm, lang: m.lang, peerOnline: !!(peer && peer.ws) }, { ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress, ua: (req.headers['user-agent'] || '').slice(0, 160) }));
    send(m, { type: 'hello', pin: room.pin, lang: m.lang, engine: room.engine, peer: peer && peer.ws ? { lang: peer.lang, name: peer.name } : null });
    if (peer && peer.ws) {
      send(peer, { type: 'peer-joined', lang: m.lang, name: m.name });
      // l'host (primo membro) crea sempre l'offerta
      const host = [...room.members.values()][0];
      send(host, { type: 'make-offer' });
    }
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return liveAudio(room, m, raw);   // audio del microfono per il motore live
      let msg; try { msg = JSON.parse(raw); } catch (e) { return; }
      room.last = Date.now();
      const p = other(room, m.token);
      if (msg.type === 'signal') {
        const d = msg.data || {};
        L('ws:signal', { pin: room.pin, member: mm, kind: d.sdp ? d.sdp.type : d.candidate ? 'candidate' : 'other',
          cand: d.candidate && d.candidate.candidate ? String(d.candidate.candidate).slice(0, 200) : undefined,
          delivered: !!(p && p.ws) });
        send(p, { type: 'signal', data: msg.data });
      }
      else if (msg.type === 'state') { L('ws:state', { pin: room.pin, member: mm, mic: !!msg.mic, cam: !!msg.cam }); send(p, { type: 'peer-state', mic: !!msg.mic, cam: !!msg.cam }); }
      else if (msg.type === 'ping') send(m, { type: 'pong' });
    });
    ws.on('close', (code) => {
      L('ws:close', { pin: room.pin, member: mm, code, replaced: m.ws !== ws });
      if (m.ws !== ws) return;
      m.ws = null;
      liveClose(m);
      send(other(room, m.token), { type: 'peer-left' });
    });
  });
});
setInterval(() => { for (const c of wss.clients) { try { c.ping(); } catch (e) {} } }, 25000);

server.listen(PORT, '127.0.0.1', () => L('server:start', { port: PORT, key: !!KEY, engine: ENGINE, MODEL_TRANSLATE, MODEL_TTS, MODEL_LIVE }));
