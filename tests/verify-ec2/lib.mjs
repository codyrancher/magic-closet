// Shared helpers for the EC2 verification recordings.
// Runs inside the mcr.microsoft.com/playwright container (--network host) on the
// EC2 host, so localhost:8300 is the closet dashboard/api and localhost:8344 is
// Rancher. TLS is self-signed (NODE_TLS_REJECT_UNAUTHORIZED=0 + ignoreHTTPSErrors).
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

export const RANCHER = process.env.RANCHER_URL || 'https://localhost:8344';
export const DASH = process.env.DASH_URL || 'http://localhost:8300';
export const API = process.env.MC_API_URL || 'http://localhost:8300';
export const OUT = process.env.OUT_DIR || '/work/videos-out';

async function call(method, url, token, body) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json).slice(0, 300)}`);
  return json;
}
export const rget = (url, token) => call('GET', url, token);
export const rpost = (url, token, body) => call('POST', url, token, body);

export async function rancherToken() {
  const j = await rpost(`${RANCHER}/v3-public/localProviders/local?action=login`, null,
    { username: 'admin', password: process.env.RANCHER_PW });
  return j.token;
}

export async function authViaCookie(context, token) {
  await context.addCookies([{ name: 'R_SESS', value: token, url: RANCHER }]);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run `fn` in a fresh recorded browser context; always saves <name>.webm.
export async function recorded(name, fn, size = { width: 1366, height: 900 }) {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: size,
    recordVideo: { dir: path.join(OUT, `.tmp-${name}`), size },
  });
  const page = await context.newPage();
  let err;
  try {
    await fn(page, context);
  } catch (e) {
    err = e;
    console.error(`[${name}] ERROR: ${e.message}`);
    try { await page.screenshot({ path: path.join(OUT, `${name}-error.png`), fullPage: true }); } catch {}
  }
  const video = page.video();
  await context.close();
  await browser.close();
  try {
    const vp = await video.path();
    fs.copyFileSync(vp, path.join(OUT, `${name}.webm`));
    console.log(`[${name}] video -> ${name}.webm`);
  } catch (e) { console.error(`[${name}] video save failed: ${e.message}`); }
  if (err) { console.log(`[${name}] RESULT: FAIL`); process.exitCode = 1; }
  else console.log(`[${name}] RESULT: PASS`);
}
