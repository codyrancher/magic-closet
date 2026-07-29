// Integration-test harness: boots the REAL api server (closet/api/src/server.js) in
// this process against a throwaway MC_ROOT, with `docker` mocked (a shim on
// PATH) and `fetch` mocked (Docker Hub / GitHub). No real containers, Rancher,
// or AWS involved. Import this first from a test file; it sets everything up and
// waits for the server before returning.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

// ---- throwaway working dir (copied fixtures, so the real repo is untouched) ----
export const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-itest-'));
const stateFile = path.join(root, 'mock-docker.state');
const logFile = path.join(root, 'mock-docker.log');

fs.cpSync(path.join(repoRoot, 'sidecars'), path.join(root, 'sidecars'), { recursive: true });
try { fs.copyFileSync(path.join(repoRoot, 'compose.stack.yml'), path.join(root, 'compose.stack.yml')); } catch {}
fs.writeFileSync(path.join(root, '.env'), 'API_PORT=8300\nCOMPOSE_PROFILES=vscode,rancher,keycloak\n');
fs.writeFileSync(stateFile, '');
fs.writeFileSync(logFile, '');

// Bake the log/state paths into the mock: server.js runs `docker compose` with
// a stripped env (only PATH+HOME), so the mock can't rely on env vars for them.
const mockBin = path.join(root, 'bin');
fs.mkdirSync(mockBin, { recursive: true });
const mockSrc = fs.readFileSync(path.join(here, 'mock', 'docker'), 'utf-8')
  .replace(/: "\$\{MOCK_DOCKER_LOG:=[^}]*\}"/, `MOCK_DOCKER_LOG="${logFile}"`)
  .replace(/: "\$\{MOCK_DOCKER_STATE:=[^}]*\}"/, `MOCK_DOCKER_STATE="${stateFile}"`);
fs.writeFileSync(path.join(mockBin, 'docker'), mockSrc);
fs.chmodSync(path.join(mockBin, 'docker'), 0o755);

// ---- env the server reads ----
process.env.MC_ROOT = root;
process.env.MC_PROJECT = 'magic-closet';
process.env.MC_ENV_FILE = '.env';
process.env.MC_COMPOSE_FILE = 'compose.stack.yml';
process.env.MOCK_DOCKER_STATE = stateFile;
process.env.MOCK_DOCKER_LOG = logFile;
process.env.PATH = `${mockBin}:${process.env.PATH}`;
process.env.GH_TOKEN = '';

// ---- mock fetch for the server's outbound calls (options sources) ----
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.github.com/repos/') && u.includes('/releases')) {
    const body = [
      { tag_name: 'v2.14.3', prerelease: false, draft: false },
      { tag_name: 'v2.15.0-rc1', prerelease: true, draft: false },   // prerelease → dropped
      { tag_name: 'v2.14.2', prerelease: false, draft: false },
      { tag_name: 'v2.13.7', prerelease: false, draft: false },
      { tag_name: 'nightly', prerelease: false, draft: false },      // non-semver → dropped
    ];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

// ---- test helpers (use realFetch so our own requests aren't mocked) ----
export const BASE = 'http://localhost:8080';
export async function api(method, p, body) {
  const res = await realFetch(`${BASE}${p}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: res.status, json, text };
}
export function setRunning(...svcs) {
  fs.writeFileSync(stateFile, svcs.length ? svcs.join('\n') + '\n' : '');
}
export const dockerLog = () => fs.readFileSync(logFile, 'utf-8');
export const clearDockerLog = () => fs.writeFileSync(logFile, '');
export const readEnv = () => fs.readFileSync(path.join(root, '.env'), 'utf-8');
export const readSecrets = () => { try { return fs.readFileSync(path.join(root, '.state', 'secrets.env'), 'utf-8'); } catch { return ''; } };
export const exists = (rel) => fs.existsSync(path.join(root, rel));
export const readFile = (rel) => fs.readFileSync(path.join(root, rel), 'utf-8');
export async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); }
  return !!fn();
}

// ---- boot the server (AFTER env + fetch are set) and wait for it ----
await import(path.join(repoRoot, 'closet', 'api', 'src', 'server.js'));
for (let i = 0; i < 100; i++) {
  try { const r = await realFetch(`${BASE}/health`); if (r.ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 50));
}
