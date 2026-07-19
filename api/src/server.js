// magic-closet sidecar control API.
//
// Zero-dependency Node HTTP server. Sidecars are discovered by scanning
// sidecars/*/sidecar.json in the repo (mounted at MC_ROOT, which is the same
// path on the host so docker compose bind mounts resolve correctly).
//
//   GET    /                      dashboard (start/stop/delete sidecars in the browser)
//   GET    /sidecars              list sidecars, their params and status
//   GET    /sidecars/:name/params/:id/options
//                                 suggested values for a param (declared via the
//                                 param's "options" config in sidecar.json)
//   POST   /sidecars/:name/start  body: { params?: {id: value}, wait?: bool }
//   POST   /sidecars/:name/stop
//   DELETE /sidecars/:name        stop + remove the container (volumes kept)
//   POST   /project/exec          body: { command: "..." } — run in project container
//   POST   /browser/open          body: { url: "..." } — open a tab in the browser
//                                 sidecar; queued (202) until the browser is ready
//   GET    /browser/queue         tabs waiting for the browser to come up
//   GET    /health

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');

const MC_ROOT = process.env.MC_ROOT || process.cwd();
const SIDECARS_DIR = path.join(MC_ROOT, 'sidecars');
// Which closet this api instance manages: compose project + env file.
// The default deployment is project "magic-closet" with ./.env; provisioned
// closets get mc-<name> with .state/closets/<name>.env.
const MC_PROJECT = process.env.MC_PROJECT || 'magic-closet';
const MC_ENV_FILE = process.env.MC_ENV_FILE || '.env';
const ENV_FILE = path.isAbsolute(MC_ENV_FILE) ? MC_ENV_FILE : path.join(MC_ROOT, MC_ENV_FILE);
const PORT = 8080;

// Containers are found via compose labels (no fixed container names — they
// would collide across closet instances)
function containerIdOf(service, project = MC_PROJECT) {
  try {
    const out = execFileSync('docker', ['ps', '-aq',
      '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', `label=com.docker.compose.service=${service}`],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return out.split('\n')[0] || null;
  } catch { return null; }
}

// ---------- sidecar discovery ----------

// A directory under sidecars/ that contains a compose.yml is a sidecar; one
// that doesn't is a group whose subdirectories are sidecars (e.g.
// sidecars/auth/keycloak). Group = directory name.
function listSidecarDefs() {
  if (!fs.existsSync(SIDECARS_DIR)) return [];
  const defs = [];
  const groupOrder = {}; // group name -> order (from <group>/group.json; default 100)
  const readDef = (dir, name, group) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'sidecar.json'), 'utf-8')); } catch { /* no metadata */ }
    defs.push({
      name, group,
      description: meta.description || '',
      port: meta.port, scheme: meta.scheme,
      params: meta.params || [], secrets: meta.secrets || [],
      rancherAuth: meta.rancherAuth,
    });
  };
  for (const entry of fs.readdirSync(SIDECARS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SIDECARS_DIR, entry.name);
    if (fs.existsSync(path.join(dir, 'compose.yml'))) {
      readDef(dir, entry.name, null);
      continue;
    }
    try {
      groupOrder[entry.name] = JSON.parse(fs.readFileSync(path.join(dir, 'group.json'), 'utf-8')).order ?? 100;
    } catch { groupOrder[entry.name] = 100; }
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const childDir = path.join(dir, child.name);
      if (fs.existsSync(path.join(childDir, 'compose.yml'))) readDef(childDir, child.name, entry.name);
    }
  }
  // Ungrouped first, then groups by their group.json order, then by name
  const orderOf = d => (d.group ? groupOrder[d.group] ?? 100 : -1);
  return defs.sort((a, b) =>
    orderOf(a) - orderOf(b) ||
    (a.group || '').localeCompare(b.group || '') ||
    a.name.localeCompare(b.name));
}

function getSidecarDef(name) {
  return listSidecarDefs().find(s => s.name === name) || null;
}

function containerStatus(name) {
  const id = containerIdOf(name);
  if (!id) return { status: 'not_created', health: null };
  try {
    const out = execFileSync('docker',
      ['inspect', '-f', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}', id],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    const [status, health] = out.trim().split('|');
    return { status, health: health || null }; // status: running | exited | created | ...
  } catch {
    return { status: 'not_created', health: null };
  }
}

// ---------- generated secrets ----------
//
// Env vars listed in a sidecar.json "secrets" array are internal — never
// user-supplied. A password is generated (same shape as the claude-harness
// generator) and persisted to .env the first time it's needed. setup.sh does
// the same at .env creation so a fresh `docker compose up -d` already has
// values.

const ALPHA_LOWER = 'abcdefghijklmnopqrstuvwxyz';
const ALPHA_UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const SAFE_SPECIAL = '@#%^&*_+-=';
const ALL_CHARS = ALPHA_LOWER + ALPHA_UPPER + DIGITS + SAFE_SPECIAL;
const crypto = require('crypto');

function generatePassword(length = 15) {
  const required = [
    ALPHA_LOWER[crypto.randomInt(ALPHA_LOWER.length)],
    ALPHA_UPPER[crypto.randomInt(ALPHA_UPPER.length)],
    DIGITS[crypto.randomInt(DIGITS.length)],
    SAFE_SPECIAL[crypto.randomInt(SAFE_SPECIAL.length)],
  ];
  for (let i = required.length; i < length; i++) {
    required.push(ALL_CHARS[crypto.randomInt(ALL_CHARS.length)]);
  }
  for (let i = required.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [required[i], required[j]] = [required[j], required[i]];
  }
  return required.join('');
}

function ensureGeneratedSecrets() {
  const env = readEnvValues();
  const updates = {};
  for (const def of listSidecarDefs()) {
    for (const envVar of def.secrets) {
      if (!env[envVar]) updates[envVar] = generatePassword();
    }
  }
  if (Object.keys(updates).length) {
    writeEnvValues(updates);
    console.log(`generated secrets for: ${Object.keys(updates).join(', ')}`);
  }
}

// ---------- param options ----------
//
// A param in sidecar.json may declare a declarative "options" source, e.g.:
//   "options": { "source": "dockerhub", "repo": "rancher/rancher",
//                "filter": "head", "pattern": "^v2\\.\\d+-head$",
//                "nextMinor": true, "prepend": ["head"] }
// dockerhub: lists image tags, keeps ones matching pattern, sorts newest
// first; nextMinor also suggests one minor version beyond the newest
// (v2.15-head -> v2.16-head); prepend values go first.

const optionsCache = new Map(); // cache key -> { at, options }
const OPTIONS_TTL = 10 * 60 * 1000;

function minorOf(tag) {
  const m = tag.match(/^v2\.(\d+)-head$/);
  return m ? Number(m[1]) : -1;
}

async function dockerHubOptions(cfg) {
  const key = JSON.stringify(cfg);
  const cached = optionsCache.get(key);
  if (cached && Date.now() - cached.at < OPTIONS_TTL) return cached.options;

  const names = new Set();
  let url = `https://hub.docker.com/v2/repositories/${cfg.repo}/tags?page_size=100`
    + (cfg.filter ? `&name=${encodeURIComponent(cfg.filter)}` : '');
  for (let page = 0; page < 3 && url; page++) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`Docker Hub returned ${resp.status}`);
    const data = await resp.json();
    for (const r of data.results || []) names.add(r.name);
    url = data.next;
  }

  const re = cfg.pattern ? new RegExp(cfg.pattern) : null;
  const matched = [...names].filter(n => (re ? re.test(n) : true));
  matched.sort((a, b) => minorOf(b) - minorOf(a));
  if (cfg.nextMinor && matched.length) {
    const newest = minorOf(matched[0]);
    if (newest >= 0) matched.unshift(`v2.${newest + 1}-head`);
  }
  const options = [...(cfg.prepend || []), ...matched.filter(o => !(cfg.prepend || []).includes(o))];
  optionsCache.set(key, { at: Date.now(), options });
  return options;
}

// github-node-engines: node major versions used by a GitHub repo's branches
// (engines.node in each branch's package.json). First option = the main
// branch's version; remaining are other majors, newest first.
async function githubNodeEngineOptions(cfg) {
  const key = JSON.stringify(cfg);
  const cached = optionsCache.get(key);
  if (cached && Date.now() - cached.at < OPTIONS_TTL) return cached.options;

  const headers = { 'User-Agent': 'magic-closet' };
  const ghToken = readEnvValues().GH_TOKEN;
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

  const branches = [cfg.mainBranch || 'master'];
  if (cfg.branchPrefix) {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${cfg.repo}/git/matching-refs/heads/${cfg.branchPrefix}`,
        { headers, signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const refs = await resp.json();
        // Only <prefix><number> branches (release-2.15), not patch branches
        // like release-2.6.13
        const esc = cfg.branchPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const branchRe = new RegExp(`^${esc}(\\d+)$`);
        const minor = n => Number(n.match(branchRe)[1]);
        const names = refs.map(r => r.ref.replace('refs/heads/', ''))
          .filter(n => branchRe.test(n))
          .sort((a, b) => minor(b) - minor(a))
          .slice(0, cfg.limit || 6);
        branches.push(...names);
      }
    } catch { /* main branch only */ }
  }

  const majors = []; // [{ value: "24", branches: ["master", "2.15"] }]
  for (const branch of branches) {
    try {
      const resp = await fetch(`https://raw.githubusercontent.com/${cfg.repo}/${branch}/package.json`,
        { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) continue;
      const pkg = await resp.json();
      const m = String(pkg.engines?.node || '').match(/(\d+)/);
      if (!m) continue;
      // "release-2.15" -> "2.15"; the main branch keeps its name
      const short = branch === (cfg.mainBranch || 'master') ? branch : branch.replace(/^[a-z-]+/i, '');
      let entry = majors.find(e => e.value === m[1]);
      if (!entry) majors.push(entry = { value: m[1], branches: [] });
      entry.branches.push(short);
    } catch { /* skip branch */ }
  }

  const [main, ...rest] = majors;
  rest.sort((a, b) => Number(b.value) - Number(a.value));
  const ordered = main ? [main, ...rest] : rest;
  const options = ordered.map(e => ({ value: e.value, label: `${e.value} (${e.branches.join(', ')})` }));
  if (options.length) optionsCache.set(key, { at: Date.now(), options });
  return options;
}

// Always resolves to [{ value, label }] regardless of source
async function resolveOptions(cfg) {
  let options;
  if (cfg.source === 'static') options = cfg.values || [];
  else if (cfg.source === 'dockerhub') options = await dockerHubOptions(cfg);
  else if (cfg.source === 'github-node-engines') options = await githubNodeEngineOptions(cfg);
  else throw new Error(`unknown options source: ${cfg.source}`);
  return options.map(o => (typeof o === 'string' ? { value: o, label: o } : o));
}

// Params with "defaultFromOptions": true get their default from the first
// suggested option (e.g. nodeVersion = whatever rancher/dashboard:master
// uses), persisted to .env when unset.
async function ensureDynamicDefaults() {
  const env = readEnvValues();
  for (const def of listSidecarDefs()) {
    for (const param of def.params) {
      if (param.defaultFromOptions && param.options && !env[param.env]) {
        try {
          const options = await resolveOptions(param.options);
          if (options.length) {
            writeEnvValues({ [param.env]: options[0].value });
            console.log(`default for ${param.env}: ${options[0].value} (from ${param.options.source})`);
          }
        } catch (err) {
          console.error(`could not resolve default for ${param.env}: ${err.message}`);
        }
      }
    }
  }
}

async function handleParamOptions(name, paramId, res) {
  const def = getSidecarDef(name);
  const param = def?.params.find(p => p.id === paramId);
  if (!param) return sendJson(res, 404, { error: `unknown param: ${name}/${paramId}` });
  if (!param.options) return sendJson(res, 200, { options: [] });
  try {
    sendJson(res, 200, { options: await resolveOptions(param.options) });
  } catch (err) {
    // Fall back to just the prepended values (e.g. "head") when offline
    const fallback = (param.options.prepend || []).map(o => ({ value: o, label: o }));
    sendJson(res, 200, { options: fallback, error: err.message });
  }
}

// ---------- .env persistence ----------

function readEnvValues() {
  const values = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      const quoted = value.match(/^"([^"]*)"|^'([^']*)'/);
      if (quoted) value = quoted[1] ?? quoted[2];
      else value = value.replace(/\s+#.*$/, '').trim(); // inline comment (dotenv style)
      values[m[1]] = value;
    }
  } catch { /* no .env yet */ }
  return values;
}

// Persist param values into .env so later `docker compose up` runs keep them.
function writeEnvValues(updates) {
  let lines = [];
  try { lines = fs.readFileSync(ENV_FILE, 'utf-8').split('\n'); } catch { /* create fresh */ }
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex(l => l.startsWith(`${key}=`));
    if (idx !== -1) lines[idx] = `${key}=${value}`;
    else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.push(`${key}=${value}`, '');
    }
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
}

// ---------- compose invocation ----------

function composeFor(project, envFile, args, cb) {
  // Minimal environment: OS env vars override .env during compose
  // interpolation, and this container's base image leaks vars like
  // NODE_VERSION that would shadow user params.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME || '/root' };
  execFile('docker', ['compose', '-p', project, '--env-file', envFile, ...args],
    { cwd: MC_ROOT, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, env },
    (err, stdout, stderr) => cb(err, stdout, stderr));
}

function compose(args, cb) {
  composeFor(MC_PROJECT, ENV_FILE, args, cb);
}

// ---------- rancher bootstrap ----------
//
// Replicates the harness's setup-rancher.sh: once the rancher sidecar's API
// answers, log in as admin, flip first-login, clear server-url, set
// agent-tls-mode, and create standard users user1-3 with generated
// passwords. Idempotent — safe to run on every rancher start.

const https = require('https');

const RANCHER_URL = 'https://rancher';
let rancherBootstrap = { state: 'idle', containerId: null }; // idle|running|done|failed

// Scoped https JSON call that accepts rancher's self-signed cert (a global
// TLS override would also disable verification for Docker Hub/GitHub calls)
function rancherApi(pathname, { method = 'GET', token, body } = {}) {
  return new Promise((resolve) => {
    const req = https.request(`${RANCHER_URL}${pathname}`, {
      method,
      rejectUnauthorized: false,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function bootstrapRancher() {
  const containerId = containerIdOf('rancher');
  if (!containerId) return;
  if (rancherBootstrap.state === 'running') return;
  if (rancherBootstrap.state === 'done' && rancherBootstrap.containerId === containerId) return;

  rancherBootstrap = { state: 'running', containerId };
  console.log('rancher bootstrap: waiting for API...');
  try {
    // Wait for the rancher API (up to ~10 minutes)
    let up = false;
    for (let i = 0; i < 120; i++) {
      const { status } = await rancherApi('/v3/');
      if (status === 200 || status === 401) { up = true; break; }
      await sleep(5000);
    }
    if (!up) throw new Error('rancher API did not become ready');

    const env = readEnvValues();
    const adminPassword = env.RANCHER_BOOTSTRAP_PASSWORD;
    if (!adminPassword) throw new Error('RANCHER_BOOTSTRAP_PASSWORD not set');

    // Login (retry — rancher accepts logins a little after /v3/ answers)
    let token = null;
    for (let i = 0; i < 10 && !token; i++) {
      const { json } = await rancherApi('/v3-public/localProviders/local?action=login', {
        method: 'POST', body: { username: 'admin', password: adminPassword },
      });
      token = json?.token || null;
      if (!token) await sleep(10000);
    }
    if (!token) throw new Error('admin login failed');
    console.log('rancher bootstrap: logged in');

    await rancherApi('/v3/settings/first-login', { method: 'PUT', token, body: { value: 'false' } });
    // Empty server-url makes the dashboard use window.location.origin
    await rancherApi('/v3/settings/server-url', { method: 'PUT', token, body: { value: '' } });
    await rancherApi('/v3/settings/agent-tls-mode', { method: 'PUT', token, body: { value: 'system-store' } });

    const users = [
      ['user1', env.RANCHER_USER1_PASSWORD, 'User One'],
      ['user2', env.RANCHER_USER2_PASSWORD, 'User Two'],
      ['user3', env.RANCHER_USER3_PASSWORD, 'User Three'],
    ];
    for (const [username, password, name] of users) {
      if (!password) continue;
      const { status, json } = await rancherApi('/v3/users', {
        method: 'POST', token,
        body: { type: 'user', username, password, name, mustChangePassword: false, enabled: true },
      });
      if (json?.id) {
        await rancherApi('/v3/globalrolebindings', {
          method: 'POST', token,
          body: { type: 'globalRoleBinding', globalRoleId: 'user', userId: json.id },
        });
        console.log(`rancher bootstrap: created ${username}`);
      } else if (status === 422) {
        console.log(`rancher bootstrap: ${username} already exists`);
      } else {
        console.log(`rancher bootstrap: could not create ${username} (HTTP ${status})`);
      }
    }

    // AWS cloud credential for the EC2 cluster command, when keys are set
    if (env.AWS_ACCESS_KEY && env.AWS_SECRET_KEY) {
      const existing = await rancherApi('/v3/cloudcredentials?name=aws-credential', { token });
      if (existing.json?.data?.length) {
        console.log('rancher bootstrap: aws credential already exists');
      } else {
        const { status } = await rancherApi('/v3/cloudcredentials', {
          method: 'POST', token,
          body: {
            type: 'cloudCredential',
            name: 'aws-credential',
            amazonec2credentialConfig: {
              accessKey: env.AWS_ACCESS_KEY,
              secretKey: env.AWS_SECRET_KEY,
              defaultRegion: env.AWS_DEFAULT_REGION || 'us-west-2',
            },
          },
        });
        console.log(`rancher bootstrap: aws credential ${status === 201 ? 'created' : `not created (HTTP ${status})`}`);
      }
    }

    // Wire whichever auth sidecar RANCHER_AUTH_PROVIDER selects (each
    // connect no-ops unless it's selected and its container is running)
    await connectRancherToKeycloak();
    await connectRancherToKeycloakSaml();
    await connectRancherToOpenLdap();
    await connectRancherToFreeIpa();

    rancherBootstrap = { state: 'done', containerId };
    console.log('rancher bootstrap: complete');
  } catch (err) {
    rancherBootstrap = { state: 'failed', containerId };
    console.error(`rancher bootstrap: ${err.message}`);
  }
}

// ---------- keycloak bootstrap ----------
//
// Provisions Keycloak once it's up: realm "rancher", a confidential OIDC
// client for Rancher, and users user1-3 (same passwords as the Rancher local
// users, so the browser extension's quick-login list works on both forms).
// Then connects Rancher's Keycloak (OIDC) auth provider to it. Idempotent.

const KEYCLOAK_URL = 'http://keycloak:8080';
const KEYCLOAK_ISSUER = `${KEYCLOAK_URL}/realms/rancher`;
let keycloakBootstrap = { state: 'idle', containerId: null };

async function kcFetch(pathname, { method = 'GET', token, body, form } = {}) {
  try {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const resp = await fetch(`${KEYCLOAK_URL}${pathname}`,
      { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
    let json = null;
    try { json = await resp.json(); } catch { /* empty/non-JSON body */ }
    return { status: resp.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

async function getRancherAdminToken() {
  const env = readEnvValues();
  if (!env.RANCHER_BOOTSTRAP_PASSWORD) return null;
  const { json } = await rancherApi('/v3-public/localProviders/local?action=login', {
    method: 'POST', body: { username: 'admin', password: env.RANCHER_BOOTSTRAP_PASSWORD },
  });
  return json?.token || null;
}

// Rancher allows exactly one enabled auth provider. RANCHER_AUTH_PROVIDER
// (param on the rancher sidecar) picks which auth sidecar gets connected;
// each connect function disables the others before enabling itself, so
// switching = change the param + Restart.
const AUTH_PROVIDERS = {
  'keycloak': { resource: 'keyCloakOIDCConfigs', id: 'keycloakoidc' },
  'keycloak-saml': { resource: 'keyCloakConfigs', id: 'keycloak' },
  'openldap': { resource: 'openLdapConfigs', id: 'openldap' },
  'freeipa': { resource: 'freeIpaConfigs', id: 'freeipa' },
  'samba-ad': { resource: 'activeDirectoryConfigs', id: 'activedirectory' },
};

function selectedAuthProvider() {
  return readEnvValues().RANCHER_AUTH_PROVIDER || 'keycloak';
}

async function disableRancherAuthProvider(token, resource, id) {
  const current = await rancherApi(`/v3/${resource}/${id}`, { token });
  if (!current.json?.enabled) return;
  const { status } = await rancherApi(`/v3/${resource}/${id}?action=disable`, { method: 'POST', token });
  if (status < 200 || status >= 300) {
    await rancherApi(`/v3/${resource}/${id}`, { method: 'PUT', token, body: { ...current.json, enabled: false } });
  }
  console.log(`auth: disabled ${id}`);
}

async function disableOtherAuthProviders(token, except) {
  for (const [name, { resource, id }] of Object.entries(AUTH_PROVIDERS)) {
    if (name !== except) await disableRancherAuthProvider(token, resource, id);
  }
}

// Enable Rancher's Keycloak (OIDC) auth provider — called from both
// bootstraps so it runs as soon as both sides are up, whichever came last.
async function connectRancherToKeycloak() {
  if (selectedAuthProvider() !== 'keycloak') return;
  if (containerStatus('rancher').status !== 'running') return;
  if (containerStatus('keycloak').status !== 'running') return;
  const env = readEnvValues();
  const token = await getRancherAdminToken();
  if (!token) return console.log('keycloak connect: rancher admin login failed');

  await disableOtherAuthProviders(token, 'keycloak');
  const current = await rancherApi('/v3/keyCloakOIDCConfigs/keycloakoidc', { token });
  if (current.json?.enabled && current.json?.issuer === KEYCLOAK_ISSUER) {
    return console.log('keycloak connect: already enabled');
  }
  const { status } = await rancherApi('/v3/keyCloakOIDCConfigs/keycloakoidc', {
    method: 'PUT', token,
    body: {
      ...(current.json || {}),
      type: 'keyCloakOIDCConfig',
      id: 'keycloakoidc',
      enabled: true,
      accessMode: 'unrestricted',
      clientId: 'rancher',
      clientSecret: env.KEYCLOAK_CLIENT_SECRET,
      issuer: KEYCLOAK_ISSUER,
      authEndpoint: `${KEYCLOAK_ISSUER}/protocol/openid-connect/auth`,
      rancherUrl: 'https://rancher/verify-auth',
      scope: 'openid profile email',
    },
  });
  console.log(`keycloak connect: rancher OIDC ${status === 200 ? 'enabled' : `failed (HTTP ${status})`}`);
}

// ---------- openldap bootstrap ----------
//
// Creates ou=users with user1-3 (same passwords as the Rancher local users)
// via the ldap CLI tools, then — when RANCHER_AUTH_PROVIDER=openldap —
// connects Rancher's OpenLDAP auth provider. Idempotent.

const LDAP_URL = 'ldap://openldap';
const LDAP_BASE = 'dc=magic-closet,dc=local';
const LDAP_ADMIN_DN = `cn=admin,${LDAP_BASE}`;
let openldapBootstrap = { state: 'idle', containerId: null };

function ldapAdd(adminPassword, ldif) {
  try {
    execFileSync('ldapadd', ['-x', '-H', LDAP_URL, '-D', LDAP_ADMIN_DN, '-w', adminPassword],
      { input: ldif, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return 'created';
  } catch (err) {
    if (`${err.stderr}`.includes('Already exists')) return 'exists';
    throw new Error(`ldapadd failed: ${`${err.stderr}`.trim().split('\n').pop()}`);
  }
}

async function connectRancherToOpenLdap() {
  if (selectedAuthProvider() !== 'openldap') return;
  if (containerStatus('rancher').status !== 'running') return;
  if (containerStatus('openldap').status !== 'running') return;
  const env = readEnvValues();
  const token = await getRancherAdminToken();
  if (!token) return console.log('openldap connect: rancher admin login failed');

  await disableOtherAuthProviders(token, 'openldap');
  const current = await rancherApi('/v3/openLdapConfigs/openldap', { token });
  if (current.json?.enabled) return console.log('openldap connect: already enabled');

  const ldapConfig = {
    servers: ['openldap'],
    port: 389,
    tls: false,
    starttls: false,
    serviceAccountDistinguishedName: LDAP_ADMIN_DN,
    serviceAccountPassword: env.OPENLDAP_ADMIN_PASSWORD,
    userSearchBase: `ou=users,${LDAP_BASE}`,
    userObjectClass: 'inetOrgPerson',
    userLoginAttribute: 'uid',
    userNameAttribute: 'cn',
    userMemberAttribute: 'memberOf',
    groupSearchBase: `ou=groups,${LDAP_BASE}`,
    groupObjectClass: 'groupOfNames',
    groupNameAttribute: 'cn',
    groupMemberMappingAttribute: 'member',
    groupMemberUserAttribute: 'entryDN',
    groupDNAttribute: 'entryDN',
    disabledStatusBitmask: 0,
    nestedGroupMembershipEnabled: false,
    connectionTimeout: 5000,
  };
  const { status } = await rancherApi('/v3/openLdapConfigs/openldap', {
    method: 'PUT', token,
    body: { ...(current.json || {}), type: 'openLdapConfig', id: 'openldap', enabled: true, accessMode: 'unrestricted', ...ldapConfig },
  });
  if (status !== 200) return console.log(`openldap connect: PUT failed (HTTP ${status})`);

  // Verify an LDAP login actually works; fall back to testAndApply (what the
  // UI does) if the direct update wasn't sufficient
  const tryLogin = () => rancherApi('/v3-public/openLdapProviders/openldap?action=login', {
    method: 'POST', body: { username: 'user1', password: env.RANCHER_USER1_PASSWORD, responseType: 'token' },
  });
  let login = await tryLogin();
  if (!login.json?.token) {
    await rancherApi('/v3/openLdapConfigs/openldap?action=testAndApply', {
      method: 'POST', token,
      body: { ldapConfig, username: 'user1', password: env.RANCHER_USER1_PASSWORD, enabled: true },
    });
    login = await tryLogin();
  }
  console.log(`openldap connect: rancher LDAP ${login.json?.token ? 'enabled (login verified)' : 'enabled but login NOT verified'}`);
}

async function bootstrapOpenLdap() {
  const containerId = containerIdOf('openldap');
  if (!containerId) return;
  if (openldapBootstrap.state === 'running') return;
  if (openldapBootstrap.state === 'done' && openldapBootstrap.containerId === containerId) return;

  openldapBootstrap = { state: 'running', containerId };
  console.log('openldap bootstrap: waiting for LDAP...');
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try {
        execFileSync('ldapsearch', ['-x', '-H', LDAP_URL, '-b', '', '-s', 'base'],
          { encoding: 'utf-8', stdio: ['ignore', 'ignore', 'ignore'] });
        up = true;
        break;
      } catch { await sleep(5000); }
    }
    if (!up) throw new Error('openldap did not become ready');

    const env = readEnvValues();
    const adminPw = env.OPENLDAP_ADMIN_PASSWORD;
    if (!adminPw) throw new Error('OPENLDAP_ADMIN_PASSWORD not set');

    for (const ou of ['users', 'groups']) {
      ldapAdd(adminPw, `dn: ou=${ou},${LDAP_BASE}\nobjectClass: organizationalUnit\nou: ${ou}\n`);
    }
    const users = [
      ['user1', env.RANCHER_USER1_PASSWORD, 'One'],
      ['user2', env.RANCHER_USER2_PASSWORD, 'Two'],
      ['user3', env.RANCHER_USER3_PASSWORD, 'Three'],
    ];
    for (const [uid, password, last] of users) {
      if (!password) continue;
      const result = ldapAdd(adminPw, [
        `dn: uid=${uid},ou=users,${LDAP_BASE}`,
        'objectClass: inetOrgPerson',
        `uid: ${uid}`,
        `cn: User ${last}`,
        `sn: ${last}`,
        `mail: ${uid}@magic-closet.local`,
        `userPassword: ${password}`,
        '',
      ].join('\n'));
      console.log(`openldap bootstrap: ${uid} ${result}`);
    }

    await connectRancherToOpenLdap();

    openldapBootstrap = { state: 'done', containerId };
    console.log('openldap bootstrap: complete');
  } catch (err) {
    openldapBootstrap = { state: 'failed', containerId };
    console.error(`openldap bootstrap: ${err.message}`);
  }
}

// ---------- keycloak SAML (same container, Rancher's "Keycloak (SAML)") ----------

const SAML_SP_ENTITY = 'https://rancher/v1-saml/keycloak/saml/metadata';
const SAML_ACS = 'https://rancher/v1-saml/keycloak/saml/acs';

// Rancher needs an SP key/cert pair for SAML; generate once into .state/
function ensureSamlSpCert() {
  const dir = path.join(MC_ROOT, '.state', 'saml');
  const keyPath = path.join(dir, 'sp.key');
  const crtPath = path.join(dir, 'sp.crt');
  if (!fs.existsSync(keyPath) || !fs.existsSync(crtPath)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', crtPath, '-days', '3650', '-subj', '/CN=rancher-saml-sp'],
      { stdio: 'ignore' });
    console.log('generated SAML SP key/cert (.state/saml)');
  }
  return { spKey: fs.readFileSync(keyPath, 'utf-8'), spCert: fs.readFileSync(crtPath, 'utf-8') };
}

async function ensureKeycloakSamlClient(token) {
  const existing = await kcFetch(`/admin/realms/rancher/clients?clientId=${encodeURIComponent(SAML_SP_ENTITY)}`, { token });
  if (existing.json?.length) return;
  const { status } = await kcFetch('/admin/realms/rancher/clients', {
    method: 'POST', token,
    body: {
      clientId: SAML_SP_ENTITY,
      name: 'Rancher (SAML)',
      enabled: true,
      protocol: 'saml',
      frontchannelLogout: true,
      redirectUris: [SAML_ACS],
      attributes: {
        'saml.authnstatement': 'true',
        'saml.client.signature': 'false',
        'saml.assertion.signature': 'true',
        'saml.force.post.binding': 'true',
        'saml_name_id_format': 'username',
      },
    },
  });
  console.log(`keycloak bootstrap: saml client ${status === 201 ? 'created' : `HTTP ${status}`}`);
  // Attribute mappers so assertions carry the fields Rancher's config reads
  const created = await kcFetch(`/admin/realms/rancher/clients?clientId=${encodeURIComponent(SAML_SP_ENTITY)}`, { token });
  const clientUuid = created.json?.[0]?.id;
  if (!clientUuid) return;
  const mappers = [['username', 'uid'], ['firstName', 'givenName'], ['lastName', 'sn'], ['email', 'email']];
  for (const [property, attribute] of mappers) {
    await kcFetch(`/admin/realms/rancher/clients/${clientUuid}/protocol-mappers/models`, {
      method: 'POST', token,
      body: {
        name: attribute,
        protocol: 'saml',
        protocolMapper: 'saml-user-property-mapper',
        config: {
          'user.attribute': property,
          'attribute.name': attribute,
          'attribute.nameformat': 'Basic',
          'friendly.name': attribute,
        },
      },
    });
  }
}

async function connectRancherToKeycloakSaml() {
  if (selectedAuthProvider() !== 'keycloak-saml') return;
  if (containerStatus('rancher').status !== 'running') return;
  if (containerStatus('keycloak').status !== 'running') return;
  const token = await getRancherAdminToken();
  if (!token) return console.log('keycloak-saml connect: rancher admin login failed');

  await disableOtherAuthProviders(token, 'keycloak-saml');
  const current = await rancherApi('/v3/keyCloakConfigs/keycloak', { token });
  if (current.json?.enabled) return console.log('keycloak-saml connect: already enabled');

  let idpMetadataContent;
  try {
    const resp = await fetch(`${KEYCLOAK_URL}/realms/rancher/protocol/saml/descriptor`,
      { signal: AbortSignal.timeout(10000) });
    idpMetadataContent = await resp.text();
  } catch {
    return console.log('keycloak-saml connect: could not fetch IdP metadata');
  }
  const { spKey, spCert } = ensureSamlSpCert();
  const { status } = await rancherApi('/v3/keyCloakConfigs/keycloak', {
    method: 'PUT', token,
    body: {
      ...(current.json || {}),
      type: 'keyCloakConfig',
      id: 'keycloak',
      enabled: true,
      accessMode: 'unrestricted',
      displayNameField: 'givenName',
      userNameField: 'uid',
      uidField: 'uid',
      groupsField: 'member',
      rancherApiHost: 'https://rancher',
      spKey,
      spCert,
      idpMetadataContent,
    },
  });
  console.log(`keycloak-saml connect: rancher SAML ${status === 200 ? 'enabled' : `failed (HTTP ${status})`}`);
}

async function bootstrapKeycloak() {
  const containerId = containerIdOf('keycloak');
  if (!containerId) return;
  if (keycloakBootstrap.state === 'running') return;
  if (keycloakBootstrap.state === 'done' && keycloakBootstrap.containerId === containerId) return;

  keycloakBootstrap = { state: 'running', containerId };
  console.log('keycloak bootstrap: waiting for API...');
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      const { status } = await kcFetch('/realms/master');
      if (status === 200) { up = true; break; }
      await sleep(5000);
    }
    if (!up) throw new Error('keycloak did not become ready');

    const env = readEnvValues();
    let token = null;
    for (let i = 0; i < 5 && !token; i++) {
      const { json } = await kcFetch('/realms/master/protocol/openid-connect/token', {
        method: 'POST',
        form: { grant_type: 'password', client_id: 'admin-cli', username: 'admin', password: env.KEYCLOAK_ADMIN_PASSWORD },
      });
      token = json?.access_token || null;
      if (!token) await sleep(5000);
    }
    if (!token) throw new Error('keycloak admin login failed');
    console.log('keycloak bootstrap: logged in');

    // Realm — sslRequired none: everything runs plain http on the compose
    // network, and Keycloak otherwise rejects the auth flow ("HTTPS required")
    const realm = await kcFetch('/admin/realms/rancher', { token });
    if (realm.status === 404) {
      const { status } = await kcFetch('/admin/realms', {
        method: 'POST', token, body: { realm: 'rancher', enabled: true, sslRequired: 'none' },
      });
      console.log(`keycloak bootstrap: realm ${status === 201 ? 'created' : `HTTP ${status}`}`);
    } else if (realm.json?.sslRequired !== 'none') {
      const { status } = await kcFetch('/admin/realms/rancher', {
        method: 'PUT', token, body: { ...realm.json, sslRequired: 'none' },
      });
      console.log(`keycloak bootstrap: realm sslRequired ${status === 204 ? 'set to none' : `HTTP ${status}`}`);
    }

    // Confidential OIDC client for Rancher
    const clients = await kcFetch('/admin/realms/rancher/clients?clientId=rancher', { token });
    if (!clients.json?.length) {
      const { status } = await kcFetch('/admin/realms/rancher/clients', {
        method: 'POST', token,
        body: {
          clientId: 'rancher',
          name: 'Rancher',
          enabled: true,
          protocol: 'openid-connect',
          publicClient: false,
          secret: env.KEYCLOAK_CLIENT_SECRET,
          standardFlowEnabled: true,
          directAccessGrantsEnabled: true,
          redirectUris: ['*'],
          webOrigins: ['*'],
        },
      });
      console.log(`keycloak bootstrap: client ${status === 201 ? 'created' : `HTTP ${status}`}`);
    }

    // Users (same passwords as the Rancher local users)
    const users = [
      ['user1', env.RANCHER_USER1_PASSWORD, 'One'],
      ['user2', env.RANCHER_USER2_PASSWORD, 'Two'],
      ['user3', env.RANCHER_USER3_PASSWORD, 'Three'],
    ];
    for (const [username, password, last] of users) {
      if (!password) continue;
      const existing = await kcFetch(`/admin/realms/rancher/users?username=${username}&exact=true`, { token });
      if (existing.json?.length) continue;
      const { status } = await kcFetch('/admin/realms/rancher/users', {
        method: 'POST', token,
        body: {
          username,
          enabled: true,
          email: `${username}@magic-closet.local`,
          emailVerified: true,
          firstName: 'User',
          lastName: last,
          credentials: [{ type: 'password', value: password, temporary: false }],
        },
      });
      console.log(`keycloak bootstrap: ${username} ${status === 201 ? 'created' : `HTTP ${status}`}`);
    }

    await ensureKeycloakSamlClient(token);
    await connectRancherToKeycloak();
    await connectRancherToKeycloakSaml();

    keycloakBootstrap = { state: 'done', containerId };
    console.log('keycloak bootstrap: complete');
  } catch (err) {
    keycloakBootstrap = { state: 'failed', containerId };
    console.error(`keycloak bootstrap: ${err.message}`);
  }
}

// ---------- freeipa bootstrap ----------
//
// Waits out the (long) ipa-server-install, creates users user1-3 via the ipa
// CLI inside the container, lifts the forced password expiry as Directory
// Manager, then — when RANCHER_AUTH_PROVIDER=freeipa — connects Rancher's
// FreeIPA auth provider. Idempotent.

const IPA_BASE = 'dc=magic-closet,dc=local';
const IPA_URL = 'ldap://freeipa';
const IPA_ADMIN_DN = `uid=admin,cn=users,cn=accounts,${IPA_BASE}`;
let freeipaBootstrap = { state: 'idle', containerId: null };

async function connectRancherToFreeIpa() {
  if (selectedAuthProvider() !== 'freeipa') return;
  if (containerStatus('rancher').status !== 'running') return;
  if (containerStatus('freeipa').status !== 'running') return;
  const env = readEnvValues();
  const token = await getRancherAdminToken();
  if (!token) return console.log('freeipa connect: rancher admin login failed');

  await disableOtherAuthProviders(token, 'freeipa');
  const current = await rancherApi('/v3/freeIpaConfigs/freeipa', { token });
  if (current.json?.enabled) return console.log('freeipa connect: already enabled');

  const ldapConfig = {
    servers: ['freeipa'],
    port: 389,
    tls: false,
    starttls: false,
    serviceAccountDistinguishedName: IPA_ADMIN_DN,
    serviceAccountPassword: env.FREEIPA_ADMIN_PASSWORD,
    userSearchBase: `cn=users,cn=accounts,${IPA_BASE}`,
    userObjectClass: 'inetorgperson',
    userLoginAttribute: 'uid',
    userNameAttribute: 'cn',
    userMemberAttribute: 'memberOf',
    groupSearchBase: `cn=groups,cn=accounts,${IPA_BASE}`,
    groupObjectClass: 'groupofnames',
    groupNameAttribute: 'cn',
    groupMemberMappingAttribute: 'member',
    groupMemberUserAttribute: 'entrydn',
    groupDNAttribute: 'entrydn',
    disabledStatusBitmask: 0,
    nestedGroupMembershipEnabled: false,
    connectionTimeout: 5000,
  };
  const { status } = await rancherApi('/v3/freeIpaConfigs/freeipa', {
    method: 'PUT', token,
    body: { ...(current.json || {}), type: 'freeIpaConfig', id: 'freeipa', enabled: true, accessMode: 'unrestricted', ...ldapConfig },
  });
  if (status !== 200) return console.log(`freeipa connect: PUT failed (HTTP ${status})`);

  const tryLogin = () => rancherApi('/v3-public/freeIpaProviders/freeipa?action=login', {
    method: 'POST', body: { username: 'user1', password: readEnvValues().RANCHER_USER1_PASSWORD, responseType: 'token' },
  });
  let login = await tryLogin();
  if (!login.json?.token) {
    await rancherApi('/v3/freeIpaConfigs/freeipa?action=testAndApply', {
      method: 'POST', token,
      body: { ldapConfig, username: 'user1', password: readEnvValues().RANCHER_USER1_PASSWORD, enabled: true },
    });
    login = await tryLogin();
  }
  console.log(`freeipa connect: rancher FreeIPA ${login.json?.token ? 'enabled (login verified)' : 'enabled but login NOT verified'}`);
}

async function bootstrapFreeIpa() {
  const containerId = containerIdOf('freeipa');
  if (!containerId) return;
  if (freeipaBootstrap.state === 'running') return;
  if (freeipaBootstrap.state === 'done' && freeipaBootstrap.containerId === containerId) return;

  freeipaBootstrap = { state: 'running', containerId };
  console.log('freeipa bootstrap: waiting for IPA (first install takes ~10 min)...');
  try {
    const env = readEnvValues();
    const adminPw = env.FREEIPA_ADMIN_PASSWORD;
    if (!adminPw) throw new Error('FREEIPA_ADMIN_PASSWORD not set');

    // The directory server answers LDAP while ipa-server-install is still
    // running, so readiness = the full stack: kinit works AND the IPA API
    // responds to a command
    let up = false;
    for (let i = 0; i < 120; i++) {
      try {
        execFileSync('docker', ['exec', containerIdOf('freeipa'), 'bash', '-c',
          `echo '${adminPw}' | kinit admin >/dev/null 2>&1 && ipa user-show admin >/dev/null 2>&1`],
          { encoding: 'utf-8', stdio: ['ignore', 'ignore', 'ignore'] });
        up = true;
        break;
      } catch { await sleep(10000); }
    }
    if (!up) throw new Error('freeipa did not become ready');

    const users = [
      ['user1', env.RANCHER_USER1_PASSWORD, 'One'],
      ['user2', env.RANCHER_USER2_PASSWORD, 'Two'],
      ['user3', env.RANCHER_USER3_PASSWORD, 'Three'],
    ];
    for (const [uid, password, last] of users) {
      if (!password) continue;
      // Exists already? (bind as admin, look for the entry)
      try {
        execFileSync('ldapsearch', ['-x', '-H', IPA_URL, '-D', IPA_ADMIN_DN, '-w', adminPw,
          '-b', `uid=${uid},cn=users,cn=accounts,${IPA_BASE}`, '-s', 'base', 'dn'],
          { encoding: 'utf-8', stdio: ['ignore', 'ignore', 'ignore'] });
        console.log(`freeipa bootstrap: ${uid} exists`);
        continue;
      } catch { /* not found — create */ }
      execFileSync('docker', ['exec', containerIdOf('freeipa'), 'bash', '-c',
        `echo '${adminPw}' | kinit admin >/dev/null && printf '%s\\n%s\\n' '${password}' '${password}' | ipa user-add ${uid} --first=User --last=${last} --email=${uid}@magic-closet.local --password`],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      // FreeIPA marks admin-set passwords expired; lift that as Directory
      // Manager so LDAP binds work without a password-change dance
      execFileSync('ldapmodify', ['-x', '-H', IPA_URL, '-D', 'cn=Directory Manager', '-w', adminPw],
        { input: `dn: uid=${uid},cn=users,cn=accounts,${IPA_BASE}\nchangetype: modify\nreplace: krbPasswordExpiration\nkrbPasswordExpiration: 20380101000000Z\n`, encoding: 'utf-8', stdio: ['pipe', 'ignore', 'pipe'] });
      console.log(`freeipa bootstrap: ${uid} created`);
    }

    await connectRancherToFreeIpa();

    freeipaBootstrap = { state: 'done', containerId };
    console.log('freeipa bootstrap: complete');
  } catch (err) {
    freeipaBootstrap = { state: 'failed', containerId };
    console.error(`freeipa bootstrap: ${err.message}`);
  }
}

// ---------- samba-ad bootstrap ----------
//
// Creates users user1-3 via samba-tool inside the container (passwords never
// expire), then — when RANCHER_AUTH_PROVIDER=samba-ad — connects Rancher's
// ActiveDirectory auth provider. Idempotent.

const AD_BASE = 'DC=samba,DC=magic-closet,DC=local';
const AD_URL = 'ldap://samba-ad';
let sambaAdBootstrap = { state: 'idle', containerId: null };

async function connectRancherToSambaAd() {
  if (selectedAuthProvider() !== 'samba-ad') return;
  if (containerStatus('rancher').status !== 'running') return;
  if (containerStatus('samba-ad').status !== 'running') return;
  const env = readEnvValues();
  const token = await getRancherAdminToken();
  if (!token) return console.log('samba-ad connect: rancher admin login failed');

  await disableOtherAuthProviders(token, 'samba-ad');
  const current = await rancherApi('/v3/activeDirectoryConfigs/activedirectory', { token });
  if (current.json?.enabled) return console.log('samba-ad connect: already enabled');

  const adConfig = {
    servers: ['samba-ad'],
    port: 389,
    tls: false,
    starttls: false,
    defaultLoginDomain: 'SAMBA',
    serviceAccountUsername: 'Administrator',
    serviceAccountPassword: env.SAMBA_ADMIN_PASSWORD,
    userSearchBase: `CN=Users,${AD_BASE}`,
    userObjectClass: 'person',
    userLoginAttribute: 'sAMAccountName',
    userNameAttribute: 'name',
    userEnabledAttribute: 'userAccountControl',
    userDisabledBitMask: 2,
    groupSearchBase: `CN=Users,${AD_BASE}`,
    groupObjectClass: 'group',
    groupNameAttribute: 'name',
    groupDNAttribute: 'distinguishedName',
    groupMemberUserAttribute: 'distinguishedName',
    groupMemberMappingAttribute: 'member',
    nestedGroupMembershipEnabled: false,
    connectionTimeout: 5000,
  };
  const { status } = await rancherApi('/v3/activeDirectoryConfigs/activedirectory', {
    method: 'PUT', token,
    body: { ...(current.json || {}), type: 'activeDirectoryConfig', id: 'activedirectory', enabled: true, accessMode: 'unrestricted', ...adConfig },
  });
  if (status !== 200) return console.log(`samba-ad connect: PUT failed (HTTP ${status})`);

  const tryLogin = () => rancherApi('/v3-public/activeDirectoryProviders/activedirectory?action=login', {
    method: 'POST', body: { username: 'user1', password: readEnvValues().RANCHER_USER1_PASSWORD, responseType: 'token' },
  });
  let login = await tryLogin();
  if (!login.json?.token) {
    await rancherApi('/v3/activeDirectoryConfigs/activedirectory?action=testAndApply', {
      method: 'POST', token,
      body: { activeDirectoryConfig: adConfig, username: 'user1', password: readEnvValues().RANCHER_USER1_PASSWORD, enabled: true },
    });
    login = await tryLogin();
  }
  console.log(`samba-ad connect: rancher AD ${login.json?.token ? 'enabled (login verified)' : 'enabled but login NOT verified'}`);
}

async function bootstrapSambaAd() {
  const containerId = containerIdOf('samba-ad');
  if (!containerId) return;
  if (sambaAdBootstrap.state === 'running') return;
  if (sambaAdBootstrap.state === 'done' && sambaAdBootstrap.containerId === containerId) return;

  sambaAdBootstrap = { state: 'running', containerId };
  console.log('samba-ad bootstrap: waiting for LDAP...');
  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try {
        execFileSync('ldapsearch', ['-x', '-H', AD_URL, '-b', '', '-s', 'base'],
          { encoding: 'utf-8', stdio: ['ignore', 'ignore', 'ignore'] });
        up = true;
        break;
      } catch { await sleep(5000); }
    }
    if (!up) throw new Error('samba-ad did not become ready');

    const env = readEnvValues();
    const users = [
      ['user1', env.RANCHER_USER1_PASSWORD, 'One'],
      ['user2', env.RANCHER_USER2_PASSWORD, 'Two'],
      ['user3', env.RANCHER_USER3_PASSWORD, 'Three'],
    ];
    for (const [uid, password, last] of users) {
      if (!password) continue;
      try {
        execFileSync('docker', ['exec', containerIdOf('samba-ad'), 'samba-tool', 'user', 'show', uid],
          { encoding: 'utf-8', stdio: ['ignore', 'ignore', 'ignore'] });
        console.log(`samba-ad bootstrap: ${uid} exists`);
        continue;
      } catch { /* not found — create */ }
      execFileSync('docker', ['exec', containerIdOf('samba-ad'), 'samba-tool', 'user', 'create', uid, password,
        '--given-name=User', `--surname=${last}`, `--mail-address=${uid}@samba.magic-closet.local`],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      execFileSync('docker', ['exec', containerIdOf('samba-ad'), 'samba-tool', 'user', 'setexpiry', uid, '--noexpiry'],
        { encoding: 'utf-8', stdio: ['ignore', 'ignore', 'ignore'] });
      console.log(`samba-ad bootstrap: ${uid} created`);
    }

    await connectRancherToSambaAd();

    sambaAdBootstrap = { state: 'done', containerId };
    console.log('samba-ad bootstrap: complete');
  } catch (err) {
    sambaAdBootstrap = { state: 'failed', containerId };
    console.error(`samba-ad bootstrap: ${err.message}`);
  }
}

// ---------- workspace clone (GITHUB_URL) ----------
//
// GITHUB_URL (param on the vscode sidecar, but executed in the project
// container) points at a rancher/dashboard PR or issue:
//   .../pull/123   -> clone + fetch the PR head onto branch pr-123
//   .../issues/456 -> clone the default branch + create branch issue-456
//   bare repo URL  -> clone the default branch
// The clone lands in /workspace/dashboard (blob-less partial clone: full
// history, fast). Skipped while /workspace/dashboard exists — delete it to
// re-clone. Log: workspace/.clone.log.

let cloneRunning = false;

function ensureWorkspaceClone() {
  const env = readEnvValues();
  const url = env.GITHUB_URL;
  if (!url || cloneRunning) return;
  if (containerStatus('project').status !== 'running') return;
  try {
    execFileSync('docker', ['exec', containerIdOf('project'), 'test', '-d', '/workspace/dashboard'],
      { stdio: 'ignore' });
    return; // already cloned
  } catch { /* not cloned yet */ }

  const m = url.match(/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(pull|issues)\/(\d+))?(?:[/?#]|$)/);
  if (!m) return console.log(`workspace: unrecognized GITHUB_URL: ${url}`);
  const [, owner, repo, kind, num] = m;
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  const clone = `git clone --filter=blob:none ${repoUrl} /workspace/dashboard && cd /workspace/dashboard`;
  let script;
  if (kind === 'pull') {
    script = `${clone} && git fetch origin pull/${num}/head:pr-${num} && git checkout pr-${num}`;
  } else if (kind === 'issues') {
    script = `${clone} && git checkout -b issue-${num}`;
  } else {
    script = clone;
  }

  cloneRunning = true;
  const what = kind ? `${kind === 'pull' ? 'PR' : 'issue'} #${num}` : 'default branch';
  console.log(`workspace: cloning ${owner}/${repo} (${what}) into /workspace/dashboard...`);
  execFile('docker', ['exec', '-u', '1000:1000', containerIdOf('project'), 'bash', '-c',
    `set -e; { ${script}; } > /workspace/.clone.log 2>&1`],
    { maxBuffer: 1024 * 1024 }, (err) => {
      cloneRunning = false;
      console.log(err
        ? 'workspace: clone FAILED — see workspace/.clone.log'
        : `workspace: clone done (${what})`);
    });
}

// Catch sidecar starts the API didn't initiate (plain `docker compose up`)
setInterval(() => {
  if (containerStatus('rancher').status === 'running') bootstrapRancher();
  if (containerStatus('keycloak').status === 'running') bootstrapKeycloak();
  if (containerStatus('openldap').status === 'running') bootstrapOpenLdap();
  if (containerStatus('freeipa').status === 'running') bootstrapFreeIpa();
  if (containerStatus('samba-ad').status === 'running') bootstrapSambaAd();
  ensureWorkspaceClone();
}, 30000);

// ---------- browser tabs ----------
//
// Chromium's CDP only accepts IP/localhost Host headers, so we resolve the
// browser service name to its IP (the sidecar's cdp-proxy exposes CDP there).

const dns = require('dns').promises;

const tabQueue = [];
let flushing = false;

async function cdpBase() {
  const { address } = await dns.lookup('rancher-browser', { family: 4 });
  return `http://${address}:9222`;
}

async function browserReady() {
  try {
    const base = await cdpBase();
    const resp = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(3000) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function openTab(url) {
  const base = await cdpBase();
  const resp = await fetch(`${base}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT', signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error(`CDP /json/new returned ${resp.status}`);
  return resp.json();
}

// Flush queued tabs (FIFO) once the browser answers. Runs forever; no-op
// while the queue is empty or the browser is down.
setInterval(async () => {
  if (flushing || !tabQueue.length) return;
  flushing = true;
  try {
    if (await browserReady()) {
      while (tabQueue.length) {
        await openTab(tabQueue[0].url);
        const opened = tabQueue.shift();
        console.log(`browser queue: opened ${opened.url}`);
      }
    }
  } catch { /* browser went away mid-flush — retry next tick */ }
  flushing = false;
}, 3000);

// ---------- http plumbing ----------

function sendJson(res, code, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(data + '\n');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!data.trim()) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ---------- handlers ----------

function handleList(res) {
  const env = readEnvValues();
  const sidecars = listSidecarDefs().map(s => {
    const state = containerStatus(s.name);
    return {
      ...s,
      status: state.status,
      health: state.health,
      hostPort: s.port ? env[s.port] || null : null,
      params: s.params.map(p => ({ ...p, value: env[p.env] ?? p.default })),
      ...(s.name === 'rancher' ? { bootstrap: rancherBootstrap.state } : {}),
      ...(s.name === 'keycloak' ? { bootstrap: keycloakBootstrap.state } : {}),
      ...(s.name === 'openldap' ? { bootstrap: openldapBootstrap.state } : {}),
      ...(s.name === 'freeipa' ? { bootstrap: freeipaBootstrap.state } : {}),
      ...(s.name === 'samba-ad' ? { bootstrap: sambaAdBootstrap.state } : {}),
    };
  });
  sendJson(res, 200, {
    sidecars,
    rancher: {
      running: containerStatus('rancher').status === 'running',
      authProvider: selectedAuthProvider(),
    },
  });
}

// Apply an auth sidecar's provider mode to Rancher (persists the selection so
// bootstraps keep re-applying it after restarts)
const AUTH_CONNECTORS = {
  'keycloak': () => connectRancherToKeycloak(),
  'keycloak-saml': () => connectRancherToKeycloakSaml(),
  'openldap': () => connectRancherToOpenLdap(),
  'freeipa': () => connectRancherToFreeIpa(),
  'samba-ad': () => connectRancherToSambaAd(),
};

// ---------- closets (multi-instance provisioning) ----------
//
// A closet = a full magic-closet compose project on this host. The default
// deployment is the "magic-closet" closet; POST /closets provisions another
// one: its own compose project (mc-<name>), env file with an allocated port
// block (base 8500 + n*100) and generated secrets, and its own workspace.
// Each closet runs its own api container, which manages its sidecars — this
// controller only creates, lists and destroys closets.

const CLOSETS_DIR = path.join(MC_ROOT, '.state', 'closets');
// Port offsets within a closet's 100-port block
const CLOSET_PORTS = {
  API_PORT:             0,
  DEV_PORT:             5,
  VSCODE_PORT:          10,
  RANCHER_BROWSER_PORT: 20,
  KEYCLOAK_PORT:        30,
  OPENLDAP_PORT:        40,
  RANCHER_PORT:         44,
  SAMBA_LDAP_PORT:      50,
  FIGMA_PORT:           60,
};
const CLOSET_BASE_START = 8500;
// name -> 'provisioning' | 'deleting' (in-memory; compose runs async)
const closetOps = new Map();

function readEnvFile(file) {
  const values = {};
  try {
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) values[m[1]] = m[2].trim().replace(/\s+#.*$/, '').trim();
    }
  } catch { /* missing */ }
  return values;
}

function listProvisionedClosets() {
  if (!fs.existsSync(CLOSETS_DIR)) return [];
  return fs.readdirSync(CLOSETS_DIR).filter(f => f.endsWith('.env')).map(f => {
    const name = f.slice(0, -4);
    const env = readEnvFile(path.join(CLOSETS_DIR, f));
    return {
      name,
      project: env.MC_PROJECT || `mc-${name}`,
      apiPort: Number(env.API_PORT) || null,
      portBase: Number(env.MC_PORT_BASE) || null,
    };
  });
}

function handleClosetsList(res) {
  const defs = listSidecarDefs();
  const running = defs.filter(d => containerStatus(d.name).status === 'running').length;
  const local = {
    name: MC_PROJECT,
    local: true,
    apiPort: Number(readEnvValues().API_PORT) || 8300,
    sidecars: { running, total: defs.length },
    authProvider: selectedAuthProvider(),
  };
  const provisioned = listProvisionedClosets().map((c) => ({
    ...c,
    local: false,
    op: closetOps.get(c.name) || null,
    running: !!containerIdOf('api', c.project),
  }));
  sendJson(res, 200, { closets: [local, ...provisioned], hostGateway: hostGatewayIp() });
}

// Host ports are reachable from inside compose networks via the bridge
// gateway — viewers inside the rancher-browser need this to reach other
// closets' ports
let cachedGateway;
function hostGatewayIp() {
  if (cachedGateway !== undefined) return cachedGateway;
  try {
    cachedGateway = execFileSync('sh', ['-c', "ip route show default | awk '{print $3; exit}'"],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { cachedGateway = null; }
  return cachedGateway;
}

function handleClosetCreate(body, res) {
  const name = (body.name || '').trim();
  if (!/^[a-z][a-z0-9-]{0,20}$/.test(name)) {
    return sendJson(res, 400, { error: 'name must be lowercase alphanumeric/dashes, starting with a letter' });
  }
  if (name === 'magic-closet' || listProvisionedClosets().some(c => c.name === name)) {
    return sendJson(res, 409, { error: `closet "${name}" already exists` });
  }

  const usedBases = new Set(listProvisionedClosets().map(c => c.portBase));
  let base = CLOSET_BASE_START;
  while (usedBases.has(base)) base += 100;

  const envFile = path.join(CLOSETS_DIR, `${name}.env`);
  const lines = [
    `MC_PROJECT=mc-${name}`,
    `MC_ENV_FILE=.state/closets/${name}.env`,
    `MC_WORKSPACE=./workspaces/${name}`,
    `MC_PORT_BASE=${base}`,
    `COMPOSE_PROFILES=${(body.profiles || ['vscode', 'rancher-browser', 'rancher', 'keycloak']).join(',')}`,
    'PUID=1000',
    'PGID=1000',
    ...Object.entries(CLOSET_PORTS).map(([k, off]) => `${k}=${base + off}`),
    'RANCHER_TAG=head',
    'RANCHER_AUTH_PROVIDER=keycloak',
    'NODE_VERSION=',
    'GH_TOKEN=',
    'FIGMA_API_KEY=',
    'APPCO_EMAIL=',
    'APPCO_TOKEN=',
    'AWS_ACCESS_KEY=',
    'AWS_SECRET_KEY=',
    'AWS_DEFAULT_REGION=us-west-2',
    'RANCHER_PRIME=',
    'GITHUB_URL=',
  ];
  // Generated secrets, so the very first `up` already has them
  for (const def of listSidecarDefs()) {
    for (const envVar of def.secrets) lines.push(`${envVar}=${generatePassword()}`);
  }
  fs.mkdirSync(CLOSETS_DIR, { recursive: true });
  fs.mkdirSync(path.join(MC_ROOT, 'workspaces', name), { recursive: true });
  fs.writeFileSync(envFile, lines.join('\n') + '\n');

  closetOps.set(name, 'provisioning');
  console.log(`closet ${name}: provisioning (project mc-${name}, ports ${base}-${base + 99})`);
  composeFor(`mc-${name}`, envFile, ['up', '-d'], (err, stdout, stderr) => {
    closetOps.delete(name);
    console.log(`closet ${name}: ${err ? `provisioning FAILED: ${stderr.slice(-300)}` : 'provisioned'}`);
  });
  sendJson(res, 202, { status: 'provisioning', name, apiPort: base + CLOSET_PORTS.API_PORT });
}

function handleClosetDelete(name, res) {
  const closet = listProvisionedClosets().find(c => c.name === name);
  if (!closet) return sendJson(res, 404, { error: `unknown closet: ${name}` });
  const envFile = path.join(CLOSETS_DIR, `${name}.env`);

  closetOps.set(name, 'deleting');
  console.log(`closet ${name}: deleting`);
  composeFor(closet.project, envFile, ['down', '-v', '--remove-orphans'], (err) => {
    closetOps.delete(name);
    if (!err) fs.rmSync(envFile, { force: true });
    console.log(`closet ${name}: ${err ? 'delete FAILED' : 'deleted (workspace kept in workspaces/)'}`);
  });
  sendJson(res, 202, { status: 'deleting', name });
}

async function handleAuthApply(body, res) {
  const provider = body.provider;
  if (!AUTH_CONNECTORS[provider]) {
    return sendJson(res, 400, { error: `unknown auth provider: ${provider}`, accepted: Object.keys(AUTH_CONNECTORS) });
  }
  if (containerStatus('rancher').status !== 'running') {
    return sendJson(res, 409, { error: 'rancher is not running' });
  }
  writeEnvValues({ RANCHER_AUTH_PROVIDER: provider });
  try {
    await AUTH_CONNECTORS[provider]();
    sendJson(res, 200, { status: 'applied', provider });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleStart(name, body, res) {
  const def = getSidecarDef(name);
  if (!def) return sendJson(res, 404, { error: `unknown sidecar: ${name}` });
  ensureGeneratedSecrets();
  await ensureDynamicDefaults();

  // Accept params either nested ({params: {tag: "x"}}) or flat ({tag: "x"})
  const supplied = body.params || body;
  const updates = {};
  const unknown = [];
  for (const [key, value] of Object.entries(supplied)) {
    if (key === 'wait' || key === 'params') continue;
    const param = def.params.find(p => p.id === key);
    if (!param) { unknown.push(key); continue; }
    updates[param.env] = String(value);
  }
  if (unknown.length) {
    return sendJson(res, 400, {
      error: `unknown param(s) for ${name}: ${unknown.join(', ')}`,
      accepted: def.params.map(p => p.id),
    });
  }
  if (Object.keys(updates).length) writeEnvValues(updates);
  ensureWorkspaceClone();

  const args = ['--profile', name, 'up', '-d'];
  if (body.wait) args.push('--wait');
  args.push(name);
  compose(args, (err, stdout, stderr) => {
    if (err) return sendJson(res, 500, { error: 'compose up failed', detail: stderr.trim() });
    if (name === 'rancher') {
      // Re-run the (idempotent) bootstrap on every explicit start so newly
      // configured params — e.g. AWS keys — are applied without a recreate
      if (rancherBootstrap.state !== 'running') rancherBootstrap = { state: 'idle', containerId: null };
      bootstrapRancher();
    }
    if (name === 'keycloak') {
      if (keycloakBootstrap.state !== 'running') keycloakBootstrap = { state: 'idle', containerId: null };
      bootstrapKeycloak();
    }
    if (name === 'openldap') {
      if (openldapBootstrap.state !== 'running') openldapBootstrap = { state: 'idle', containerId: null };
      bootstrapOpenLdap();
    }
    if (name === 'freeipa') {
      if (freeipaBootstrap.state !== 'running') freeipaBootstrap = { state: 'idle', containerId: null };
      bootstrapFreeIpa();
    }
    if (name === 'samba-ad') {
      if (sambaAdBootstrap.state !== 'running') sambaAdBootstrap = { state: 'idle', containerId: null };
      bootstrapSambaAd();
    }
    sendJson(res, 200, { status: 'started', sidecar: name, params: updates, containerStatus: containerStatus(name) });
  });
}

function handleStop(name, res) {
  if (!getSidecarDef(name)) return sendJson(res, 404, { error: `unknown sidecar: ${name}` });
  compose(['--profile', name, 'stop', name], (err, stdout, stderr) => {
    if (err) return sendJson(res, 500, { error: 'compose stop failed', detail: stderr.trim() });
    sendJson(res, 200, { status: 'stopped', sidecar: name });
  });
}

function handleDelete(name, res) {
  if (!getSidecarDef(name)) return sendJson(res, 404, { error: `unknown sidecar: ${name}` });
  compose(['--profile', name, 'rm', '-sf', name], (err, stdout, stderr) => {
    if (err) return sendJson(res, 500, { error: 'compose rm failed', detail: stderr.trim() });
    sendJson(res, 200, { status: 'deleted', sidecar: name });
  });
}

function handleExec(body, res) {
  if (!body.command) return sendJson(res, 400, { error: 'missing "command"' });
  const projectId = containerIdOf('project');
  if (!projectId) return sendJson(res, 409, { error: 'project container is not running' });
  execFile('docker', ['exec', '-u', '1000:1000', projectId, 'bash', '-lc', body.command],
    { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, timeout: (body.timeoutSeconds || 300) * 1000 },
    (err, stdout, stderr) => {
      sendJson(res, 200, { exitCode: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
}

async function handleBrowserOpen(body, res) {
  if (!body.url) return sendJson(res, 400, { error: 'missing "url"' });
  try {
    const tab = await openTab(body.url);
    sendJson(res, 200, { status: 'opened', url: body.url, targetId: tab.id });
  } catch {
    tabQueue.push({ url: body.url, queuedAt: new Date().toISOString() });
    sendJson(res, 202, { status: 'queued', url: body.url, position: tabQueue.length });
  }
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  // CORS — the Rancher UI extension calls this API from the dashboard origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
    }
    if (req.method === 'GET' && (url.pathname === '/favicon.svg' || url.pathname === '/logo.svg')) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(fs.readFileSync(path.join(__dirname, 'logo.svg')));
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (req.method === 'GET' && url.pathname === '/sidecars') {
      return handleList(res);
    }
    if (parts[0] === 'sidecars' && parts[1]) {
      const name = parts[1];
      if (req.method === 'GET' && parts[2] === 'params' && parts[3] && parts[4] === 'options') {
        return handleParamOptions(name, parts[3], res);
      }
      if (req.method === 'POST' && parts[2] === 'start') {
        return handleStart(name, await readBody(req), res);
      }
      if (req.method === 'POST' && parts[2] === 'stop') {
        return handleStop(name, res);
      }
      if (req.method === 'DELETE' && parts.length === 2) {
        return handleDelete(name, res);
      }
    }
    if (req.method === 'POST' && url.pathname === '/project/exec') {
      return handleExec(await readBody(req), res);
    }
    if (req.method === 'POST' && url.pathname === '/auth/apply') {
      return handleAuthApply(await readBody(req), res);
    }
    if (url.pathname === '/closets' && req.method === 'GET') return handleClosetsList(res);
    if (url.pathname === '/closets' && req.method === 'POST') return handleClosetCreate(await readBody(req), res);
    if (parts[0] === 'closets' && parts[1] && req.method === 'DELETE') {
      return handleClosetDelete(decodeURIComponent(parts[1]), res);
    }
    // Built Rancher extension assets (for developer-load):
    // /extension/<pkg-version>/<file> -> rancher-extension/dist-pkg/...
    if (req.method === 'GET' && parts[0] === 'extension') {
      const distRoot = path.join(MC_ROOT, 'rancher-extension', 'dist-pkg');
      const file = path.join(distRoot, ...parts.slice(1));
      if (!file.startsWith(distRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return sendJson(res, 404, { error: 'not found' });
      }
      const types = { '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json' };
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'POST' && url.pathname === '/browser/open') {
      return handleBrowserOpen(await readBody(req), res);
    }
    if (req.method === 'GET' && url.pathname === '/browser/queue') {
      return sendJson(res, 200, { queue: tabQueue });
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
});

ensureGeneratedSecrets();
ensureDynamicDefaults();
if (containerStatus('rancher').status === 'running') bootstrapRancher();
if (containerStatus('keycloak').status === 'running') bootstrapKeycloak();
if (containerStatus('openldap').status === 'running') bootstrapOpenLdap();
if (containerStatus('freeipa').status === 'running') bootstrapFreeIpa();
if (containerStatus('samba-ad').status === 'running') bootstrapSambaAd();
ensureWorkspaceClone();

server.listen(PORT, () => {
  console.log(`magic-closet api listening on :${PORT} (root: ${MC_ROOT})`);
});
