#!/usr/bin/env node
// Prova di Gemini Live Translate (voce -> voce in streaming) su registrazioni reali.
// Ogni file viene inviato a velocità reale in blocchi da 100 ms, come farebbe il microfono,
// e si misura dopo quanto arriva la voce tradotta.
//
//   node tools/live-translate-test.js --to kk frase_it.wav altra_frase_it.m4a
//   node tools/live-translate-test.js --to it фраза_kk.wav
//
// Richiede GEMINI_API_KEY (.env o variabile d'ambiente). Per file diversi da WAV 16 kHz mono 16 bit serve ffmpeg.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');

// ---------- config ----------
const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const KEY = process.env.GEMINI_API_KEY || '';
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=';
const IN_RATE = 16000, CHUNK_MS = 100, CHUNK = IN_RATE * 2 * CHUNK_MS / 1000;   // 3200 byte ogni 100 ms

// PowerShell e cmd non espandono * e ?: lo faccio qui (solo nel nome del file)
function expand(arg) {
  const base = path.basename(arg);
  if (!/[*?]/.test(base) || fs.existsSync(arg)) return [arg];
  const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  let names = [];
  try { names = fs.readdirSync(path.dirname(arg)).filter(n => re.test(n)).sort(); } catch (e) {}
  return names.length ? names.map(n => path.join(path.dirname(arg), n)) : [arg];
}

const opt = { to: null, model: 'gemini-3.5-live-translate-preview', out: path.join(ROOT, 'live-test-out'), tail: 4 };
const files = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--to') opt.to = argv[++i];
  else if (a === '--model') opt.model = argv[++i];
  else if (a === '--out') opt.out = path.resolve(argv[++i]);
  else if (a === '--tail') opt.tail = parseFloat(argv[++i]);
  else files.push(...expand(a));
}
if (!opt.to || !files.length) {
  console.log('Usage: node tools/live-translate-test.js --to <kk|it> [--model name] [--out dir] [--tail seconds] file1 [file2 ...]\n' +
    '  --to    language of the translation (the files must be in the other language)\n' +
    '  --tail  seconds of silence sent after each file so the model can finish (default 4)');
  process.exit(1);
}
if (!KEY) { console.error('GEMINI_API_KEY is missing (.env or environment variable)'); process.exit(1); }

// ---------- audio ----------
function parseWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let p = 12, fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4), size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(p + 8), channels: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    else if (id === 'data') return fmt && Object.assign(fmt, { data: buf.subarray(p + 8, Math.min(buf.length, p + 8 + size)) });
    p += 8 + size + (size & 1);
  }
  return null;
}
function loadPcm16k(file) {
  const w = parseWav(fs.readFileSync(file));
  let pcm;
  if (w && w.format === 1 && w.channels === 1 && w.rate === IN_RATE && w.bits === 16) pcm = w.data;
  else {
    try {
      pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', String(IN_RATE), '-'], { maxBuffer: 512 * 1024 * 1024 });
    } catch (e) {
      throw new Error('cannot read ' + file + ': use WAV 16 kHz mono 16-bit or install ffmpeg');
    }
  }
  return pcm.subarray(0, pcm.length & ~1);
}
function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
// inizio e fine del parlato nel file (soglia fissa su finestre da 20 ms)
function speechSpan(pcm) {
  const fr = IN_RATE / 50, n = pcm.length / 2;
  let first = -1, last = -1;
  for (let i = 0; i + fr <= n; i += fr) {
    let s = 0;
    for (let j = 0; j < fr; j++) { const v = pcm.readInt16LE((i + j) * 2) / 32768; s += v * v; }
    if (Math.sqrt(s / fr) > 0.02) { if (first < 0) first = i; last = i + fr; }
  }
  return first < 0 ? { start: 0, end: n / IN_RATE, guessed: true } : { start: first / IN_RATE, end: last / IN_RATE };
}
// cosa sente l'ascoltatore: originale piano + traduzione riprodotta man mano che arriva (in coda, senza sovrapposizioni)
function timeline(pcmIn, chunks, rate) {
  let cursor = 0;
  const placed = chunks.map(c => { const at = Math.max(cursor, c.t); cursor = at + c.pcm.length / 2 / rate; return { at, pcm: c.pcm }; });
  const nIn = pcmIn.length / 2, n = Math.ceil(Math.max(nIn / IN_RATE, cursor) * rate) + 1;
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * IN_RATE / rate, a = Math.floor(x);
    if (a + 1 >= nIn) break;
    const f = x - a;
    mix[i] = ((1 - f) * pcmIn.readInt16LE(a * 2) + f * pcmIn.readInt16LE(a * 2 + 2)) / 32768 * 0.3;
  }
  for (const p of placed) {
    const o = Math.round(p.at * rate);
    for (let j = 0; j * 2 < p.pcm.length && o + j < n; j++) mix[o + j] += p.pcm.readInt16LE(j * 2) / 32768;
  }
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mix[i] * 32767))), i * 2);
  return { pcm: out, playEnd: placed.length ? cursor : null };
}

// ---------- sessione Live ----------
function translate(pcm, to) {
  return new Promise((resolve, reject) => {
    const r = { input: '', output: '', inLang: null, outLang: null, chunks: [], outRate: 24000, firstIn: null, firstOut: null, firstAudio: null, usage: null, closed: null };
    const all = Buffer.concat([pcm, Buffer.alloc(Math.round(opt.tail * 1000 / CHUNK_MS) * CHUNK)]);
    const started = Date.now();
    let t0 = 0, sent = 0, ready = false, done = false, lastMsg = 0, pump = null, watch = null;
    const now = () => (Date.now() - t0) / 1000;
    const stamp = () => now().toFixed(2).padStart(6) + 's';
    const finish = err => {
      if (done) return;
      done = true; clearInterval(pump); clearInterval(watch);
      try { ws.close(); } catch (e) {}
      err ? reject(err) : resolve(r);
    };
    const ws = new WebSocket(WS_URL + encodeURIComponent(KEY));
    // nell'esempio della documentazione le trascrizioni stanno in generationConfig, ma il server le accetta solo in setup
    ws.on('open', () => ws.send(JSON.stringify({
      setup: {
        model: 'models/' + opt.model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          translationConfig: { targetLanguageCode: to, echoTargetLanguage: false }
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      }
    })));
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch (e) { return; }
      if (m.setupComplete && !ready) {
        ready = true; t0 = lastMsg = Date.now();
        // invio a velocità reale, come un microfono
        pump = setInterval(() => {
          const due = Math.min(all.length, (Math.floor((Date.now() - t0) / CHUNK_MS) + 1) * CHUNK);
          while (sent < due && ws.readyState === WebSocket.OPEN) {
            const c = all.subarray(sent, Math.min(sent + CHUNK, all.length));
            ws.send(JSON.stringify({ realtimeInput: { audio: { data: c.toString('base64'), mimeType: 'audio/pcm;rate=16000' } } }));
            sent += c.length;
          }
          if (sent >= all.length) clearInterval(pump);
        }, 20);
        return;
      }
      lastMsg = Date.now();
      if (m.usageMetadata) r.usage = m.usageMetadata;
      if (m.goAway) console.log(stamp(), 'goAway', JSON.stringify(m.goAway));
      const c = m.serverContent;
      if (!c) return;
      const it = c.inputTranscription, ot = c.outputTranscription;
      if (it && it.text) {
        if (r.firstIn === null) r.firstIn = now();
        r.input += it.text; if (it.languageCode) r.inLang = it.languageCode;
        console.log(stamp(), ' in  ›', it.text.trim());
      }
      if (ot && ot.text) {
        if (r.firstOut === null) r.firstOut = now();
        r.output += ot.text; if (ot.languageCode) r.outLang = ot.languageCode;
        console.log(stamp(), ' out ›', ot.text.trim());
      }
      for (const p of (c.modelTurn && c.modelTurn.parts) || []) {
        if (!p.inlineData || !p.inlineData.data) continue;
        const rm = /rate=(\d+)/.exec(p.inlineData.mimeType || '');
        if (rm) r.outRate = parseInt(rm[1], 10);
        if (r.firstAudio === null) { r.firstAudio = now(); console.log(stamp(), ' ♪   first translated audio'); }
        r.chunks.push({ t: now(), pcm: Buffer.from(p.inlineData.data, 'base64') });
      }
      if (c.interrupted) console.log(stamp(), ' (interrupted)');
    });
    ws.on('close', (code, reason) => {
      if (done) return;
      const why = code + ' ' + String(reason || '');
      if (!ready) return finish(new Error('connection closed before setup: ' + why));
      r.closed = why; console.log(stamp(), ' closed by server:', why);
      finish();
    });
    ws.on('error', e => finish(e));
    // fine: tutto inviato e nessun messaggio da 3 s, oppure limite massimo
    const limit = all.length / 2 / IN_RATE + 30;
    watch = setInterval(() => {
      if (!ready) { if (Date.now() - started > 15000) finish(new Error('no setupComplete after 15 s')); return; }
      if (sent >= all.length && Date.now() - lastMsg > 3000) finish();
      else if (now() > limit) { console.log(stamp(), ' timeout'); finish(); }
    }, 200);
  });
}

// ---------- main ----------
(async () => {
  fs.mkdirSync(opt.out, { recursive: true });
  const report = { model: opt.model, to: opt.to, at: new Date().toISOString(), files: [] };
  for (const file of files) {
    const name = path.basename(file).replace(/\.[^.]+$/, '');
    console.log('\n=== ' + file + ' → ' + opt.to);
    let pcm;
    try { pcm = loadPcm16k(file); } catch (e) { console.error('  ' + e.message); report.files.push({ file, error: e.message }); continue; }
    const sp = speechSpan(pcm);
    console.log('  audio ' + (pcm.length / 2 / IN_RATE).toFixed(1) + ' s, speech ' + sp.start.toFixed(2) + '–' + sp.end.toFixed(2) + ' s' + (sp.guessed ? ' (not detected)' : ''));
    let r;
    try { r = await translate(pcm, opt.to); } catch (e) { console.error('  error: ' + e.message); report.files.push({ file, error: e.message }); continue; }
    const outPcm = Buffer.concat(r.chunks.map(c => c.pcm));
    const tl = timeline(pcm, r.chunks, r.outRate);
    const res = {
      file, input: r.input.trim(), inLang: r.inLang, output: r.output.trim(), outLang: r.outLang,
      speechStart: +sp.start.toFixed(2), speechEnd: +sp.end.toFixed(2),
      firstInputText: r.firstIn, firstOutputText: r.firstOut, firstAudio: r.firstAudio,
      startLag: r.firstAudio === null ? null : +(r.firstAudio - sp.start).toFixed(2),          // da inizio parlato a prima voce tradotta
      endLag: tl.playEnd === null ? null : +(tl.playEnd - sp.end).toFixed(2),                   // da fine parlato a fine voce tradotta
      translatedAudioSec: +(outPcm.length / 2 / r.outRate).toFixed(2),
      usage: r.usage, closed: r.closed
    };
    if (outPcm.length) {
      fs.writeFileSync(path.join(opt.out, name + '.' + opt.to + '.wav'), wav(outPcm, r.outRate));
      fs.writeFileSync(path.join(opt.out, name + '.' + opt.to + '.timeline.wav'), wav(tl.pcm, r.outRate));
    }
    console.log('  original:    ' + (res.input || '—') + (res.inLang ? '  [' + res.inLang + ']' : ''));
    console.log('  translation: ' + (res.output || '—') + (res.outLang ? '  [' + res.outLang + ']' : ''));
    console.log('  first translated audio ' + (res.startLag === null ? '—' : res.startLag + ' s after speech start') +
      ', translation finished ' + (res.endLag === null ? '—' : res.endLag + ' s after speech end'));
    report.files.push(res);
  }
  const rep = path.join(opt.out, 'report-' + report.at.replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(rep, JSON.stringify(report, null, 2));
  console.log('\n' + 'file'.padEnd(34) + 'start lag  end lag');
  for (const f of report.files) {
    console.log(path.basename(f.file).slice(0, 33).padEnd(34) + (f.error ? 'ERROR ' + f.error.slice(0, 60)
      : String(f.startLag === null ? '—' : f.startLag + ' s').padEnd(11) + (f.endLag === null ? '—' : f.endLag + ' s')));
  }
  console.log('\nreport: ' + rep + '\naudio:  ' + opt.out);
})();
