// KZIT client: WebRTC 1:1 + segmentazione voce (VAD) + riproduzione della voce tradotta
(() => {
  'use strict';
  const BASE = location.pathname.replace(/\/[^/]*$/, '') || '/kzit';   // "/kzit"
  const $ = id => document.getElementById(id);
  // ---------- log verso il server (tutto) ----------
  let token = null;
  const Q = [];
  const sid = Math.random().toString(36).slice(2, 10);
  function clog(ev, d) { Q.push({ ev, t: Date.now(), d: Object.assign({ sid }, d || {}) }); if (Q.length > 80) flush(); }
  function flush(beacon) {
    if (!Q.length) return;
    const body = JSON.stringify({ events: Q.splice(0, Q.length) });
    if (beacon && navigator.sendBeacon) { try { navigator.sendBeacon(BASE + '/api/clog?t=' + (token || ''), new Blob([body], { type: 'application/json' })); return; } catch (e) {} }
    fetch(BASE + '/api/clog', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-token': token || '' }, body, keepalive: true }).catch(() => {});
  }
  setInterval(flush, 3000);
  addEventListener('pagehide', () => { clog('pagehide'); flush(true); });
  addEventListener('visibilitychange', () => clog('visibility', { state: document.visibilityState }));
  addEventListener('online', () => clog('net', { online: true }));
  addEventListener('offline', () => clog('net', { online: false }));
  addEventListener('error', e => clog('js-error', { msg: e.message, src: e.filename, line: e.lineno }));
  addEventListener('unhandledrejection', e => clog('js-rejection', { msg: String(e.reason && (e.reason.message || e.reason)) }));
  clog('boot', { url: location.href, ua: navigator.userAgent, lang: navigator.language, screen: screen.width + 'x' + screen.height, dpr: devicePixelRatio,
    conn: navigator.connection ? { type: navigator.connection.effectiveType, down: navigator.connection.downlink, rtt: navigator.connection.rtt } : null });
  const T = {
    it: { waitPeer: 'In attesa · Ожидание', live: 'In linea · На связи', left: "L'altro è uscito · Собеседник вышел",
          mic: 'Microfono', talk: 'Ti ascolto…', translating: 'Traduzione in corso…', muted: 'Microfono spento',
          errPin: 'PIN non valido · Неверный PIN', errFull: 'Stanza piena · Комната заполнена', errMany: 'Troppi tentativi, riprova tra qualche minuto',
          errMedia: 'Consenti microfono e fotocamera · Разрешите доступ к микрофону и камере', reconnect: 'Riconnessione…',
          errKey: 'Per creare una stanza serve il link con la chiave · Для создания комнаты нужна ссылка с ключом' },
    ru: { waitPeer: 'Ожидание · In attesa', live: 'На связи · In linea', left: 'Собеседник вышел · L\'altro è uscito',
          mic: 'Микрофон', talk: 'Слушаю вас…', translating: 'Перевод…', muted: 'Микрофон выключен',
          errPin: 'Неверный PIN · PIN non valido', errFull: 'Комната заполнена · Stanza piena', errMany: 'Слишком много попыток, попробуйте через несколько минут',
          errMedia: 'Разрешите доступ к микрофону и камере · Consenti microfono e fotocamera', reconnect: 'Переподключение…',
          errKey: 'Для создания комнаты нужна ссылка с ключом · Per creare una stanza serve il link con la chiave' }
  };
  let lang = 'it', S = T.it;
  let pin = null, role = null, ws = null, pc = null, engine = 'classic';
  let localStream = null, remoteStream = null, audioCtx = null;
  let micOn = true, camOn = true, peerPresent = false, closing = false;

  // ---------- home ----------
  document.querySelectorAll('.lang').forEach(b => b.onclick = () => {
    document.querySelectorAll('.lang').forEach(x => x.classList.toggle('on', x === b));
    lang = b.dataset.lang; S = T[lang]; clog('ui:lang', { lang });
  });
  const pinIn = $('pin');
  pinIn.oninput = () => { pinIn.value = pinIn.value.replace(/\D/g, '').slice(0, 6); };
  const qp = new URLSearchParams(location.search).get('pin');
  if (qp) pinIn.value = qp.replace(/\D/g, '').slice(0, 6);
  const qe = new URLSearchParams(location.search).get('engine');   // ?engine=classic per confrontare col vecchio motore
  const qk = new URLSearchParams(location.search).get('key');      // chiave per creare stanze (CREATE_KEY sul server)
  $('create').onclick = () => start('room', Object.assign({}, qe ? { engine: qe } : {}, qk ? { key: qk } : {}));
  $('join').onclick = () => {
    if (pinIn.value.length !== 6) { $('err').textContent = S.errPin; return; }
    start('join', { pin: pinIn.value });
  };
  pinIn.onkeydown = e => { if (e.key === 'Enter') $('join').click(); };

  let starting = false, vadStarted = false;
  async function start(kind, body) {
    if (starting || token) return;            // evita doppio clic: due microfoni = traduzioni doppie
    starting = true;
    document.querySelectorAll('#home button').forEach(b => b.disabled = true);
    try { await doStart(kind, body); }
    finally { starting = false; if (!token) document.querySelectorAll('#home button').forEach(b => b.disabled = false); }
  }
  async function doStart(kind, body) {
    $('err').textContent = '';
    clog('ui:start', { kind, lang, pin: body.pin || null });
    // AudioContext creato dentro il click: serve su iOS/Safari per poter riprodurre la voce tradotta
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    clog('audioctx', { state: audioCtx.state, rate: audioCtx.sampleRate });
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
      });
    } catch (e) {
      clog('media:error', { name: e.name, msg: e.message, try: 'audio+video' });
      try { localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); camOn = false; }
      catch (e2) { clog('media:error', { name: e2.name, msg: e2.message, try: 'audio' }); $('err').textContent = S.errMedia; return; }
    }
    try {
      clog('media:ok', { tracks: localStream.getTracks().map(t => ({ kind: t.kind, label: t.label, settings: t.getSettings ? t.getSettings() : null })) });
      const devs = await navigator.mediaDevices.enumerateDevices();
      clog('media:devices', { list: devs.map(d => d.kind + ':' + (d.label || '?')) });
    } catch (e) {}
    const r = await fetch(BASE + '/api/' + kind, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ lang }, body)) });
    const j = await r.json().catch(() => ({}));
    clog('api:' + kind, { status: r.status, error: j.error || null, pin: j.pin || null, role: j.role || null, engine: j.engine || null });
    if (!r.ok) {
      localStream.getTracks().forEach(t => t.stop());
      $('err').textContent = j.error === 'full' ? S.errFull : j.error === 'too_many' ? S.errMany : j.error === 'key' ? S.errKey : S.errPin;
      return;
    }
    token = j.token; pin = j.pin; role = j.role; engine = j.engine === 'live' ? 'live' : 'classic';
    $('pinShow').textContent = pin; $('pinBig').textContent = pin;
    history.replaceState(null, '', BASE + '/?pin=' + pin);
    $('home').classList.add('hidden'); $('call').classList.remove('hidden');
    $('local').srcObject = localStream;
    if (!camOn) $('bCam').classList.add('off');
    setStatus(S.waitPeer, false);
    startVad();
    connectWs();
  }

  function setStatus(t, live) { $('status').textContent = t; $('status').classList.toggle('live', !!live); }

  // ---------- segnalazione ----------
  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + BASE + '/ws?token=' + token);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => clog('ws:open');
    ws.onerror = () => clog('ws:error');
    ws.onmessage = ev => {
      if (ev.data instanceof ArrayBuffer) return playLive(ev.data);   // voce tradotta del motore live
      const m = JSON.parse(ev.data); if (m.type !== 'pong') clog('ws:msg', { type: m.type, kind: m.data ? (m.data.sdp ? m.data.sdp.type : m.data.candidate ? 'candidate' : '?') : undefined, id: m.id }); onMsg(m); };
    ws.onclose = (e) => { clog('ws:close', { code: e.code, closing }); if (!closing) { setStatus(S.reconnect, false); setTimeout(connectWs, 1500); } };
  }
  function wsSend(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  setInterval(() => wsSend({ type: 'ping' }), 20000);

  async function onMsg(m) {
    if (m.type === 'hello') { if (m.peer) peerUp(); }
    else if (m.type === 'peer-joined') peerUp();
    else if (m.type === 'make-offer') { await ensurePc(); const o = await pc.createOffer(); await pc.setLocalDescription(o); wsSend({ type: 'signal', data: { sdp: pc.localDescription } }); }
    else if (m.type === 'signal') await onSignal(m.data);
    else if (m.type === 'peer-left') { peerPresent = false; setStatus(S.left, false); $('waiting').classList.remove('hidden'); if (pc) { pc.close(); pc = null; } $('remote').srcObject = null; }
    else if (m.type === 'pending') addPending(m.id);
    else if (m.type === 'drop') removePending(m.id);
    else if (m.type === 'caption') onCaption(m);
    else if (m.type === 'live-text') onLiveText(m);
    else if (m.type === 'error') removePending(m.id);
  }
  function peerUp() { peerPresent = true; $('waiting').classList.add('hidden'); setStatus(S.live, true); }

  async function ensurePc() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] });
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    clog('pc:create', { role });
    pc.onicecandidate = e => { clog('pc:local-candidate', { c: e.candidate ? e.candidate.candidate : 'end' }); if (e.candidate) wsSend({ type: 'signal', data: { candidate: e.candidate } }); };
    pc.oniceconnectionstatechange = () => clog('pc:ice', { state: pc && pc.iceConnectionState });
    pc.onicegatheringstatechange = () => clog('pc:gathering', { state: pc && pc.iceGatheringState });
    pc.onsignalingstatechange = () => clog('pc:signaling', { state: pc && pc.signalingState });
    pc.onicecandidateerror = e => clog('pc:candidate-error', { code: e.errorCode, text: e.errorText, url: e.url });
    pc.ontrack = e => {
      clog('pc:track', { kind: e.track.kind, muted: e.track.muted });
      remoteStream = e.streams[0];
      // solo voce tradotta: l'audio originale dell'altro non si riproduce mai
      const v = $('remote'); v.muted = true; v.srcObject = remoteStream; v.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      clog('pc:state', { state: pc && pc.connectionState });
      if (pc && pc.connectionState === 'connected') setStatus(S.live, true);
      if (pc && pc.connectionState === 'failed' && role === 'host') { pc.restartIce && pc.restartIce(); pc.createOffer({ iceRestart: true }).then(o => pc.setLocalDescription(o)).then(() => wsSend({ type: 'signal', data: { sdp: pc.localDescription } })); }
    };
    return pc;
  }
  async function onSignal(d) {
    await ensurePc();
    if (d.sdp) {
      await pc.setRemoteDescription(d.sdp);
      if (d.sdp.type === 'offer') { const a = await pc.createAnswer(); await pc.setLocalDescription(a); wsSend({ type: 'signal', data: { sdp: pc.localDescription } }); }
    } else if (d.candidate) { try { await pc.addIceCandidate(d.candidate); } catch (e) {} }
  }

  // statistiche WebRTC ogni 10 s
  setInterval(async () => {
    if (!pc) return;
    try {
      const st = await pc.getStats(); const out = { in: {}, out: {} }; let pair = null; const cands = {};
      st.forEach(r => {
        if (r.type === 'inbound-rtp') out.in[r.kind] = { bytes: r.bytesReceived, lost: r.packetsLost, jitter: r.jitter, fps: r.framesPerSecond, w: r.frameWidth, h: r.frameHeight, audioLevel: r.audioLevel };
        if (r.type === 'outbound-rtp') out.out[r.kind] = { bytes: r.bytesSent, fps: r.framesPerSecond, w: r.frameWidth, h: r.frameHeight, limit: r.qualityLimitationReason };
        if (r.type === 'candidate-pair' && (r.selected || r.nominated) && r.state === 'succeeded') pair = r;
        if (r.type === 'local-candidate' || r.type === 'remote-candidate') cands[r.id] = r.candidateType + '/' + r.protocol + '/' + (r.address || r.ip || '') ;
      });
      if (pair) out.pair = { local: cands[pair.localCandidateId], remote: cands[pair.remoteCandidateId], rtt: pair.currentRoundTripTime, out: pair.availableOutgoingBitrate };
      out.state = pc.connectionState; out.remoteMuted = $('remote').muted; out.remotePaused = $('remote').paused;
      clog('pc:stats', out);
    } catch (e) {}
  }, 10000);

  // ---------- controlli ----------
  $('bMic').onclick = () => {
    micOn = !micOn; clog('ui:mic', { on: micOn });
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    $('bMic').classList.toggle('off', !micOn);
    wsSend({ type: 'state', mic: micOn, cam: camOn });
  };
  $('bCam').onclick = () => {
    const vt = localStream.getVideoTracks(); if (!vt.length) return;
    camOn = !camOn; clog('ui:cam', { on: camOn }); vt.forEach(t => t.enabled = camOn);
    $('bCam').classList.toggle('off', !camOn);
    wsSend({ type: 'state', mic: micOn, cam: camOn });
  };
  $('bEnd').onclick = () => {
    closing = true; clog('ui:end'); flush(true);
    try { navigator.sendBeacon(BASE + '/api/leave?t=' + token, new Blob(['{}'], { type: 'text/plain' })); } catch (e) {}
    try { ws.close(); } catch (e) {}
    if (pc) pc.close();
    localStream && localStream.getTracks().forEach(t => t.stop());
    location.href = BASE + '/';
  };

  // ---------- VAD: taglia la voce in frasi e le manda al server ----------
  let ttsPlaying = 0, ttsUntil = 0;
  function startVad() {
    if (vadStarted) return; vadStarted = true;
    const src = audioCtx.createMediaStreamSource(new MediaStream(localStream.getAudioTracks()));
    const proc = audioCtx.createScriptProcessor(2048, 1, 1);
    const sink = audioCtx.createGain(); sink.gain.value = 0;
    src.connect(proc); proc.connect(sink); sink.connect(audioCtx.destination);
    const sr = audioCtx.sampleRate, frameMs = 2048 / sr * 1000;
    clog('vad:start', { rate: sr, frameMs: Math.round(frameMs) });
    let peak = 0, lastLvl = 0, lvlMax = 0;
    let noise = 0.004, speaking = false, silenceMs = 0, speechMs = 0, chunks = [], pre = [];
    const PRE = Math.ceil(300 / frameMs), END_SIL = 750, MAX_MS = 14000, MIN_SPEECH = 350;
    proc.onaudioprocess = e => {
      const x = e.inputBuffer.getChannelData(0);
      let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i];
      const rms = Math.sqrt(s / x.length);
      const blocked = !micOn || ttsPlaying > 0 || performance.now() < ttsUntil;
      const thr = Math.max(0.012, noise * 3.2);
      const voiced = !blocked && rms > thr;
      if (!speaking && !voiced) noise = noise * 0.97 + rms * 0.03;
      $('lvl').style.width = Math.min(100, rms / 0.08 * 100) + '%';
      if (speaking && rms > peak) peak = rms;
      if (rms > lvlMax) lvlMax = rms;
      if (performance.now() - lastLvl > 5000) { clog('level', { max: +lvlMax.toFixed(4), noise: +noise.toFixed(4), thr: +thr.toFixed(4), blocked, micOn, tts: ttsPlaying }); lastLvl = performance.now(); lvlMax = 0; }
      if (engine === 'live') return liveFrame(x, voiced, blocked);
      const buf = new Float32Array(x);
      if (!speaking) {
        pre.push(buf); if (pre.length > PRE) pre.shift();
        if (voiced) { speaking = true; peak = rms; chunks = pre.slice(); pre = []; silenceMs = 0; speechMs = frameMs; meter(true); clog('vad:speech-start', { rms: +rms.toFixed(4), thr: +thr.toFixed(4) }); }
      } else {
        chunks.push(buf);
        if (voiced) { speechMs += frameMs; silenceMs = 0; } else silenceMs += frameMs;
        const total = chunks.length * frameMs;
        if (silenceMs >= END_SIL || total >= MAX_MS || blocked) {
          speaking = false; meter(false);
          const why = blocked ? 'blocked' : total >= MAX_MS ? 'max' : 'silence';
          const sent = speechMs >= MIN_SPEECH && !blocked;
          clog('vad:segment', { totalMs: Math.round(total), speechMs: Math.round(speechMs), peak: +peak.toFixed(4), end: why, sent });
          if (sent) ship(chunks, sr);
          chunks = []; pre = [];
        }
      }
    };
    down16k = makeDown16k(sr);
    meter(false);
  }

  // ---------- motore live: audio continuo verso il server mentre si parla ----------
  // Il modello traduce al ritmo dell'audio che riceve: dopo l'ultima voce continuo a mandare 3,5 s
  // (silenzio se il microfono è bloccato) perché finisca la frase. 400 ms di pre-roll per non perdere l'attacco.
  const LIVE_TAIL = 3500, LIVE_PRE = 4, LIVE_END_SIL = 750;
  let down16k = null, liveUntil = 0, liveLastVoice = 0, liveTalk = false, livePre = [];
  function makeDown16k(sr) {   // Float32 a sr -> blocchi Int16 da 100 ms a 16 kHz (media sulla finestra, come toWav16k)
    const ratio = sr / 16000;
    let carry = new Float32Array(0), pos = 0, out = new Int16Array(1600), n = 0;
    return x => {
      const a = new Float32Array(carry.length + x.length); a.set(carry); a.set(x, carry.length);
      const chunks = [];
      while (pos + ratio <= a.length) {
        const s = Math.floor(pos), e = Math.floor(pos + ratio);
        let sum = 0; for (let j = s; j < e; j++) sum += a[j];
        const v = Math.max(-1, Math.min(1, sum / Math.max(1, e - s)));
        out[n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (n === 1600) { chunks.push(out); out = new Int16Array(1600); n = 0; }
        pos += ratio;
      }
      const k = Math.floor(pos); carry = a.slice(k); pos -= k;
      return chunks;
    };
  }
  function liveFrame(x, voiced, blocked) {
    const now = performance.now();
    if (voiced) {
      if (!liveTalk) { liveTalk = true; meter(true); clog('vad:speech-start', { live: true }); }
      liveLastVoice = now; liveUntil = now + LIVE_TAIL;
    } else if (liveTalk && now - liveLastVoice > LIVE_END_SIL) { liveTalk = false; meter(false); clog('vad:speech-end', { live: true }); }
    const sending = now < liveUntil;
    for (const c of down16k(blocked ? new Float32Array(x.length) : x)) {
      if (!sending) { livePre.push(c); if (livePre.length > LIVE_PRE) livePre.shift(); continue; }
      if (ws && ws.readyState === 1) { while (livePre.length) ws.send(livePre.shift().buffer); ws.send(c.buffer); }
    }
  }
  let liveHead = 0;
  function playLive(ab) {
    if (ab.byteLength < 2) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const i16 = new Int16Array(ab, 0, ab.byteLength >> 1), b = audioCtx.createBuffer(1, i16.length, 24000), ch = b.getChannelData(0);
    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
    const s = audioCtx.createBufferSource(); s.buffer = b; s.connect(audioCtx.destination);
    const t = audioCtx.currentTime;
    if (liveHead < t + 0.12) { liveHead = t + 0.12; clog('tts:play', { live: true, ctx: audioCtx.state }); }   // inizio di un nuovo tratto
    s.start(liveHead); liveHead += b.duration;
    ttsPlaying++;
    s.onended = () => { ttsPlaying--; ttsUntil = performance.now() + 400; };
  }

  function meter(talk) {
    $('meter').classList.toggle('talk', talk);
    $('meterTxt').textContent = !micOn ? S.muted : talk ? S.talk : S.mic;
  }

  let uttSeq = 0;
  function ship(chunks, sr) {
    let n = 0; chunks.forEach(c => n += c.length);
    const all = new Float32Array(n); let o = 0; chunks.forEach(c => { all.set(c, o); o += c.length; });
    const wav = toWav16k(all, sr);
    const seq = ++uttSeq, t0 = performance.now();
    fetch(BASE + '/api/utt', { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'x-token': token, 'x-seq': sid + '-' + seq }, body: wav })
      .then(r => r.json().then(j => clog('utt:sent', { seq, status: r.status, id: j.id || null, skipped: !!j.skipped, error: j.error || null, bytes: wav.size, ms: Math.round(performance.now() - t0) })))
      .catch(e => clog('utt:send-error', { seq, msg: e.message }));
  }
  function toWav16k(f32, sr) {
    const ratio = sr / 16000, len = Math.floor(f32.length / ratio), pcm = new Int16Array(len);
    for (let i = 0; i < len; i++) {
      const a = Math.floor(i * ratio), b = Math.min(f32.length, Math.floor((i + 1) * ratio));
      let s = 0; for (let j = a; j < b; j++) s += f32[j];
      const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2), dv = new DataView(buf);
    const w = (p, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 16000, true);
    dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    return new Blob([buf], { type: 'audio/wav' });
  }

  // ---------- sottotitoli e voce tradotta ----------
  const subs = $('subs'), log = $('log');
  function addPending(id) {
    const d = document.createElement('div'); d.className = 'cap self pending'; d.id = 'p' + id; d.textContent = S.translating;
    subs.appendChild(d); trim();
  }
  function removePending(id) { const d = $('p' + id); if (d) d.remove(); }
  function capEl(m) {
    const d = document.createElement('div'); d.className = 'cap ' + m.who;
    const tr = document.createElement('div'); tr.className = 'tr'; tr.textContent = m.who === 'peer' ? m.trans : m.orig;
    const or = document.createElement('div'); or.className = 'or'; or.textContent = m.who === 'peer' ? m.orig : m.trans;
    d.appendChild(tr); d.appendChild(or); return d;
  }
  function onCaption(m) {
    clog('caption', { id: m.id, who: m.who, from: m.from, to: m.to, ms: m.ms, orig: m.orig, trans: m.trans, audio: !!m.audio });
    removePending(m.id);
    subs.appendChild(capEl(m)); trim();
    log.appendChild(capEl(m)); log.scrollTop = log.scrollHeight;
    if (m.who === 'peer' && m.audio) playTts(m.audio);
  }
  function trim() { while (subs.children.length > 3) { const c = subs.querySelector('.cap:not(.live)'); if (!c) break; c.remove(); } }
  setInterval(() => { const c = subs.querySelector('.cap:not(.pending):not(.live)'); if (c && subs.children.length > 1 && Date.now() - (c._t || (c._t = Date.now())) > 12000) c.remove(); }, 1000);

  // sottotitoli del motore live: il testo arriva a pezzi, lo accumulo in un fumetto per chi parla
  // e lo chiudo dopo 2,5 s senza testo nuovo (il modello non segnala la fine della frase)
  const liveCap = {};
  function onLiveText(m) {
    let c = liveCap[m.who];
    if (!c) {
      const el = document.createElement('div'); el.className = 'cap live ' + m.who;
      const tr = document.createElement('div'); tr.className = 'tr';
      const or = document.createElement('div'); or.className = 'or';
      el.appendChild(tr); el.appendChild(or); subs.appendChild(el); trim();
      c = liveCap[m.who] = { el, tr, or, orig: '', trans: '', t: 0 };
    }
    c[m.kind] += m.text; c.t = Date.now();
    const big = m.who === 'peer' ? 'trans' : 'orig';
    c.tr.textContent = c[big].trim(); c.or.textContent = c[big === 'trans' ? 'orig' : 'trans'].trim();
  }
  function liveEnd(who) {
    const c = liveCap[who]; delete liveCap[who];
    c.el.classList.remove('live');
    clog('caption', { live: true, who, orig: c.orig.trim(), trans: c.trans.trim() });
    log.appendChild(c.el.cloneNode(true)); log.scrollTop = log.scrollHeight;
  }
  setInterval(() => { for (const who in liveCap) { const c = liveCap[who]; if (Date.now() - c.t > 2500 || c.orig.length + c.trans.length > 260) liveEnd(who); } }, 500);

  let ttsQueue = Promise.resolve();
  function playTts(b64) {
    ttsQueue = ttsQueue.then(() => new Promise(async resolve => {
      try {
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        const bin = atob(b64), arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const ab = await audioCtx.decodeAudioData(arr.buffer);
        const s = audioCtx.createBufferSource(); s.buffer = ab; s.connect(audioCtx.destination);
        ttsPlaying++;
        s.onended = () => { ttsPlaying--; ttsUntil = performance.now() + 400; resolve(); };
        clog('tts:play', { sec: +ab.duration.toFixed(2), ctx: audioCtx.state });
        s.start();
      } catch (e) { clog('tts:error', { msg: e.message }); resolve(); }
    }));
  }
})();
