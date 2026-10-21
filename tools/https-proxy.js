#!/usr/bin/env node
// Proxy HTTPS per provare KZIT dal telefono sulla stessa rete Wi-Fi (fa il lavoro di Apache in produzione).
// Il browser concede microfono e fotocamera solo su HTTPS: certificato autofirmato in tools/.dev-cert/.
//
//   node server.js                 (127.0.0.1:3121)
//   node tools/https-proxy.js      (0.0.0.0:3443 -> 127.0.0.1:3121)
//   telefono: https://<IP del PC>:3443/kzit/   (accettare l'avviso sul certificato)
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');

const LISTEN = parseInt(process.env.PROXY_PORT || '3443', 10);
const TARGET = parseInt(process.env.PORT || '3121', 10);
const CERT = path.join(__dirname, '.dev-cert');
if (!fs.existsSync(path.join(CERT, 'key.pem'))) {
  console.error('missing ' + CERT + '/key.pem and cert.pem (self-signed certificate, see README)');
  process.exit(1);
}

const fwd = req => ({ 'x-forwarded-for': req.socket.remoteAddress, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host });

const server = https.createServer({ key: fs.readFileSync(path.join(CERT, 'key.pem')), cert: fs.readFileSync(path.join(CERT, 'cert.pem')) }, (req, res) => {
  if (req.url === '/' || req.url === '') { res.writeHead(302, { Location: '/kzit/' }); return res.end(); }
  const p = http.request({ host: '127.0.0.1', port: TARGET, method: req.method, path: req.url, headers: Object.assign({}, req.headers, fwd(req)) }, pr => {
    res.writeHead(pr.statusCode, pr.headers);
    pr.pipe(res);
  });
  p.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('KZIT server not running on 127.0.0.1:' + TARGET); });
  req.pipe(p);
});

// WebSocket (/kzit/ws): passo la richiesta di upgrade così com'è e poi collego i due socket
server.on('upgrade', (req, sock, head) => {
  const up = net.connect(TARGET, '127.0.0.1', () => {
    const h = Object.assign({}, req.headers, fwd(req));
    up.write(req.method + ' ' + req.url + ' HTTP/1.1\r\n' + Object.entries(h).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
    if (head && head.length) up.write(head);
    sock.pipe(up).pipe(sock);
  });
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});

server.listen(LISTEN, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === 'IPv4' && !a.internal).map(a => a.address);
  console.log('KZIT HTTPS proxy :' + LISTEN + ' -> 127.0.0.1:' + TARGET);
  for (const ip of ips) console.log('  https://' + ip + ':' + LISTEN + '/kzit/');
});
