// Transparent TLS terminator in front of openvscode-server.
//
// openvscode-server only speaks plain HTTP/WS (no --cert flag). Served over
// http:// on a non-localhost origin, VS Code web webviews break: the browser
// refuses to register the workbench's service worker outside a secure context,
// so webview resources never load and panels (Markdown preview, the Claude Code
// extension, ...) render blank. Serving the host port over HTTPS makes it a
// secure context and fixes them.
//
// This just decrypts TLS and pipes the raw byte stream to the local HTTP
// server, so HTTP and the WebSocket upgrade both pass through unchanged.
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';

const LISTEN = Number(process.env.VSCODE_TLS_PORT || 9443);
const UPSTREAM = Number(process.env.VSCODE_UPSTREAM_PORT || 9000);
const key = fs.readFileSync(process.env.VSCODE_TLS_KEY || '/data/tls/key.pem');
const cert = fs.readFileSync(process.env.VSCODE_TLS_CERT || '/data/tls/crt.pem');

const server = tls.createServer({ key, cert }, (client) => {
  const upstream = net.connect(UPSTREAM, '127.0.0.1');
  const cleanup = () => { client.destroy(); upstream.destroy(); };
  client.on('error', cleanup);
  upstream.on('error', cleanup);
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on('error', (e) => console.error('[tls-proxy] error:', e.message));
server.listen(LISTEN, '0.0.0.0', () => console.log(`[tls-proxy] https ${LISTEN} -> 127.0.0.1:${UPSTREAM}`));
