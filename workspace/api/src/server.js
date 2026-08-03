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
//   POST   /exec                  body: { command: "..." } — run in the workspace container
//   POST   /browser/open          body: { url: "..." } — open a tab in the browser
//                                 sidecar; queued (202) until the browser is ready
//   GET    /browser/queue         tabs waiting for the browser to come up
//   GET    /health

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile, spawn } = require('child_process');

const MC_ROOT = process.env.MC_ROOT || process.cwd();
// Runtime/instance state (.state, custom-sidecars, workspaces) lives here so it
// can be kept out of the source tree. Defaults to MC_ROOT (in-tree) when unset.
const DATA_DIR = process.env.MC_DATA_DIR || MC_ROOT;
const SIDECARS_DIR = fs.existsSync(path.join(MC_ROOT, 'workspace', 'sidecars'))
  ? path.join(MC_ROOT, 'workspace', 'sidecars')
  : path.join(__dirname, '..', 'sidecars');
// Which closet this api instance manages: compose project + env file.
// The default deployment is project "magic-closet" with ./.env; provisioned
// closets get mc-<name> with .state/closets/<name>.env.
const MC_PROJECT = process.env.MC_PROJECT || 'magic-closet';
const MC_ENV_FILE = process.env.MC_ENV_FILE || '.env';
const ENV_FILE = path.isAbsolute(MC_ENV_FILE) ? MC_ENV_FILE : path.join(MC_ROOT, MC_ENV_FILE);
// Generated login secrets are kept OUT of the human-facing .env: for the
// default closet they live in this gitignored runtime file, which the
// dind-entrypoint generates at init and loads into compose interpolation, and
// which we read/merge here. Provisioned closets carry their secrets inside
// their own .state env file (SECRETS_FILE null → same-file behaviour).
const IS_DEFAULT_ENV = ENV_FILE === path.join(MC_ROOT, '.env');
const SECRETS_FILE = IS_DEFAULT_ENV ? path.join(DATA_DIR, '.state', 'secrets.env') : null;
// Listen ports are overridable so the api can bind the host-published port
// directly when it runs in the root container (MC_API_PORT=8300); default 8080
// keeps the k8s/in-container-service path unchanged.
const PORT = Number(process.env.MC_API_PORT) || 8080;
const HTTPS_PORT = Number(process.env.MC_API_HTTPS_PORT) || 8443;

// ---------- kubernetes mode ----------
//
// When running inside a cluster (the "closet" Helm chart), sidecars are
// Deployments in this namespace: start/stop = scale 1/0, params live in the
// closet-config ConfigMap, secrets arrive via the pod environment. Compose
// mode is unchanged.

const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const K8S = fs.existsSync(path.join(SA_DIR, 'token')) ? {
  base: `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT || 443}`,
  token: fs.readFileSync(path.join(SA_DIR, 'token'), 'utf-8').trim(),
  ns: fs.readFileSync(path.join(SA_DIR, 'namespace'), 'utf-8').trim(),
} : null;

function k8sApi(pathname, { method = 'GET', body, contentType } = {}) {
  return new Promise((resolve) => {
    const req = require('https').request(`${K8S.base}${pathname}`, {
      method,
      rejectUnauthorized: false,
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${K8S.token}`,
        'Content-Type': contentType || 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// Synchronous callers read these caches; refreshed every 5s
let k8sDeployCache = new Map(); // name -> { desired, ready, uid }
let k8sConfigCache = {};        // closet-config ConfigMap data
let k8sNodePortCache = new Map(); // sidecar name -> assigned nodePort

async function refreshK8sCache() {
  const deps = await k8sApi(`/apis/apps/v1/namespaces/${K8S.ns}/deployments`);
  if (deps.json?.items) {
    const m = new Map();
    for (const d of deps.json.items) {
      m.set(d.metadata.name, {
        desired: d.spec.replicas ?? 0,
        ready: d.status?.readyReplicas || 0,
        uid: d.metadata.uid,
      });
    }
    k8sDeployCache = m;
  }
  const cm = await k8sApi(`/api/v1/namespaces/${K8S.ns}/configmaps/closet-config`);
  if (cm.json?.data) k8sConfigCache = cm.json.data;
  const svcs = await k8sApi(`/api/v1/namespaces/${K8S.ns}/services`);
  if (svcs.json?.items) {
    const np = new Map();
    for (const svc of svcs.json.items) {
      if (svc.spec?.type !== 'NodePort' || !svc.metadata.name.endsWith('-external')) continue;
      const port = svc.spec.ports?.find(p => p.nodePort);
      if (port) np.set(svc.metadata.name.replace(/-external$/, ''), port.nodePort);
    }
    k8sNodePortCache = np;
  }
}
if (K8S) {
  refreshK8sCache();
  setInterval(refreshK8sCache, 5000);
  console.log(`kubernetes mode: namespace ${K8S.ns}`);
}

// Containers are found via compose labels (no fixed container names — they
// would collide across closet instances)
function containerIdOf(service, project = MC_PROJECT) {
  if (K8S) return k8sDeployCache.get(service)?.uid || null;
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
// Sidecars come from two roots: the built-in `sidecars/` in the repo and a
// `custom-sidecars/` overlay — created/edited from within a closet and shared
// with every future compose closet via MC_ROOT. A custom entry shadows a
// built-in of the same name (so built-ins can be edited without touching them).
const CUSTOM_SIDECARS_DIR = path.join(DATA_DIR, 'custom-sidecars');

function scanSidecarRoot(root, custom, byName, groupOrder) {
  if (!fs.existsSync(root)) return;
  const readDef = (dir, name, group) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'sidecar.json'), 'utf-8')); } catch { /* no metadata */ }
    byName.set(name, {
      name,
      group: meta.group || group,
      description: meta.description || '',
      port: meta.port, scheme: meta.scheme,
      params: meta.params || [], secrets: meta.secrets || [],
      rancherAuth: meta.rancherAuth,
      // Freeform agent-facing guidance (URLs, login, gotchas). Single source of
      // truth so docs don't drift — surfaced in GET /sidecars and `mc list`.
      notes: meta.notes || '',
      dir, custom,
    });
  };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (fs.existsSync(path.join(dir, 'compose.yml'))) { readDef(dir, entry.name, null); continue; }
    try {
      groupOrder[entry.name] = JSON.parse(fs.readFileSync(path.join(dir, 'group.json'), 'utf-8')).order ?? 100;
    } catch { if (!(entry.name in groupOrder)) groupOrder[entry.name] = 100; }
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const childDir = path.join(dir, child.name);
      if (fs.existsSync(path.join(childDir, 'compose.yml'))) readDef(childDir, child.name, entry.name);
    }
  }
}

function listSidecarDefs() {
  const byName = new Map();
  const groupOrder = {};
  scanSidecarRoot(SIDECARS_DIR, false, byName, groupOrder);
  scanSidecarRoot(CUSTOM_SIDECARS_DIR, true, byName, groupOrder); // custom shadows built-in
  // Ungrouped first, then groups by their group.json order, then by name
  const orderOf = d => (d.group ? groupOrder[d.group] ?? 100 : -1);
  return [...byName.values()].sort((a, b) =>
    orderOf(a) - orderOf(b) ||
    (a.group || '').localeCompare(b.group || '') ||
    a.name.localeCompare(b.name));
}

function listBuiltinNames() {
  const byName = new Map();
  scanSidecarRoot(SIDECARS_DIR, false, byName, {});
  return [...byName.keys()];
}

function getSidecarDef(name) {
  return listSidecarDefs().find(s => s.name === name) || null;
}

// Custom sidecars aren't in the base compose `include:`, so their fragment must
// be passed explicitly with `-f` for compose to know the service.
function sidecarFiles(def) {
  return def && def.custom ? [path.join(def.dir, 'compose.yml')] : [];
}

function containerStatus(name) {
  if (K8S) {
    const d = k8sDeployCache.get(name);
    if (!d) return { status: 'not_created', health: null };
    if (d.desired === 0) return { status: 'exited', health: null };
    return d.ready > 0 ? { status: 'running', health: null } : { status: 'running', health: 'starting' };
  }
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
  if (K8S) return; // the closet chart generates secrets at install time
  const env = readEnvValues();
  const updates = {};
  for (const def of listSidecarDefs()) {
    for (const envVar of def.secrets) {
      if (!env[envVar]) updates[envVar] = generatePassword();
    }
  }
  if (Object.keys(updates).length) {
    writeSecretValues(updates);
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

// github-releases: a repo's actual GA releases (prereleases + drafts excluded),
// newest first. Rancher publishes many alpha/rc prereleases between GA releases,
// so we page a few deep until we've gathered `limit` GA tags (or run out).
async function githubReleasesOptions(cfg) {
  const key = JSON.stringify(cfg);
  const cached = optionsCache.get(key);
  if (cached && Date.now() - cached.at < OPTIONS_TTL) return cached.options;

  const headers = { 'User-Agent': 'magic-closet' };
  const ghToken = readEnvValues().GH_TOKEN;
  if (ghToken) headers.Authorization = `Bearer ${ghToken}`;

  const re = cfg.pattern ? new RegExp(cfg.pattern) : /^v\d+\.\d+\.\d+$/;
  const semver = t => t.replace(/^v/, '').split('.').map(Number);
  const limit = cfg.limit || 15;
  const releases = [];
  for (let page = 1; page <= (cfg.maxPages || 5); page++) {
    const resp = await fetch(`https://api.github.com/repos/${cfg.repo}/releases?per_page=100&page=${page}`,
      { headers, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) { if (releases.length) break; throw new Error(`GitHub returned ${resp.status}`); }
    const data = await resp.json();
    if (!data.length) break;
    for (const r of data) {
      if (!r.prerelease && !r.draft && re.test(r.tag_name)) releases.push(r.tag_name);
    }
    if (new Set(releases).size >= limit) break;
  }
  const sorted = [...new Set(releases)]
    .sort((a, b) => { const A = semver(a), B = semver(b); return (B[0] - A[0]) || (B[1] - A[1]) || (B[2] - A[2]); })
    .slice(0, limit);
  const options = [...(cfg.prepend || []), ...sorted.filter(o => !(cfg.prepend || []).includes(o))];
  if (options.length) optionsCache.set(key, { at: Date.now(), options });
  return options;
}

// Always resolves to [{ value, label }] regardless of source
async function resolveOptions(cfg) {
  let options;
  if (cfg.source === 'static') options = cfg.values || [];
  else if (cfg.source === 'dockerhub') options = await dockerHubOptions(cfg);
  else if (cfg.source === 'github-releases') options = await githubReleasesOptions(cfg);
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
  if (K8S) {
    // Drop kubernetes service-link vars (FOO_PORT=tcp://ip:port) that would
    // shadow our params
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!String(v).startsWith('tcp://')) env[k] = v;
    }
    return { ...env, ...k8sConfigCache };
  }
  const values = {};
  // .env first, then the generated-secrets file (secrets supplement params).
  for (const file of [ENV_FILE, SECRETS_FILE]) {
    if (!file) continue;
    try {
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!m) continue;
        let value = m[2].trim();
        const quoted = value.match(/^"([^"]*)"|^'([^']*)'/);
        if (quoted) value = quoted[1] ?? quoted[2];
        else value = value.replace(/\s+#.*$/, '').trim(); // inline comment (dotenv style)
        values[m[1]] = value;
      }
    } catch { /* file may not exist yet */ }
  }
  // Derive host ports from API_PORT for any not explicitly set — mirrors
  // dind-entrypoint.sh, which only exports the derived ports into the compose
  // process (they're not written to .env), so without this the api wouldn't
  // know a sidecar's host port and would drop its "Launch" link.
  const base = parseInt(values.API_PORT, 10) || 8300;
  for (const [k, off] of Object.entries(PORT_OFFSETS)) {
    if (values[k] == null || values[k] === '') values[k] = String(base + off);
  }
  return values;
}

// Persist param values into .env so later `docker compose up` runs keep them.
function writeEnvValues(updates) {
  if (K8S) {
    Object.assign(k8sConfigCache, updates);
    k8sApi(`/api/v1/namespaces/${K8S.ns}/configmaps/closet-config`, {
      method: 'PATCH',
      contentType: 'application/strategic-merge-patch+json',
      body: { data: updates },
    });
    return;
  }
  writeKeyValues(ENV_FILE, updates);
}

// Upsert KEY=VALUE lines into an env file (creating it + parent dir if needed).
function writeKeyValues(file, updates) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf-8').split('\n'); } catch { /* create fresh */ }
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex(l => l.startsWith(`${key}=`));
    if (idx !== -1) lines[idx] = `${key}=${value}`;
    else {
      while (lines.length && lines[lines.length - 1] === '') lines.pop();
      lines.push(`${key}=${value}`, '');
    }
  }
  fs.writeFileSync(file, lines.join('\n'));
}

// Persist generated login secrets. Default closet → the gitignored secrets
// file (keeps them out of .env); provisioned closets → their own env file.
function writeSecretValues(updates) {
  if (K8S) return writeEnvValues(updates); // the chart owns secrets in k8s
  writeKeyValues(SECRETS_FILE || ENV_FILE, updates);
}

// ---------- compose invocation ----------

// When running inside the DinD wrapper the default compose file is the wrapper
// itself, so the stack lives in a separate file — select it explicitly.
const MC_COMPOSE_FILE = process.env.MC_COMPOSE_FILE || null;

function composeFor(project, envFile, args, cb, extraFiles = []) {
  // Minimal environment: OS env vars override .env during compose
  // interpolation, and this container's base image leaks vars like
  // NODE_VERSION that would shadow user params.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME || '/root' };
  const fileArgs = [];
  if (MC_COMPOSE_FILE) fileArgs.push('-f', MC_COMPOSE_FILE);
  for (const f of extraFiles) fileArgs.push('-f', f); // e.g. a custom sidecar's fragment
  // Interpolate from .env plus, for the default closet, the generated-secrets
  // file (compose merges multiple --env-file, later wins) so ${*_PASSWORD}
  // resolve even though they no longer live in .env.
  const envFileArgs = ['--env-file', envFile];
  if (envFile === ENV_FILE && SECRETS_FILE && fs.existsSync(SECRETS_FILE)) {
    envFileArgs.push('--env-file', SECRETS_FILE);
  }
  execFile('docker', ['compose', ...fileArgs, '-p', project, ...envFileArgs, ...args],
    { cwd: MC_ROOT, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, env },
    (err, stdout, stderr) => cb(err, stdout, stderr));
}

function compose(args, cb, extraFiles) {
  composeFor(MC_PROJECT, ENV_FILE, args, cb, extraFiles);
}

// ---------- rancher bootstrap ----------
//
// Replicates the harness's setup-rancher.sh: once the rancher sidecar's API
// answers, log in as admin, flip first-login, clear server-url, set
// agent-tls-mode, and create standard users user1-3 with generated
// passwords. Idempotent — safe to run on every rancher start.

const https = require('https');

const RANCHER_URL = 'https://rancher'; // in-network name (config values, e.g. server-url fallback)

// The api runs in the ROOT container, off the sidecars' inner compose network,
// so it reaches a sidecar through its PUBLISHED host port on localhost — not the
// inner service name. (Config values a *sidecar* uses to reach another sidecar
// stay as service names: rancher's server-url, the OIDC issuer, etc.)
function sidecarHostUrl(scheme, portEnv, offset) {
  const v = readEnvValues();
  const port = Number(v[portEnv]) || ((Number(v.API_PORT) || 8300) + offset);
  return `${scheme}://localhost:${port}`;
}

// Base URL the api uses to REACH a sidecar for its own bootstrap calls. In k8s
// the api is a pod on the cluster network, so it addresses sidecars by their
// in-cluster service name (`https://rancher`, `http://keycloak:8080`, ...) —
// the same names the sidecars use for each other. In compose the api runs in
// the root container, off the sidecars' inner network, so it must use the
// published host port on localhost instead (sidecarHostUrl).
function sidecarApiUrl(k8sUrl, scheme, portEnv, offset) {
  return K8S ? k8sUrl : sidecarHostUrl(scheme, portEnv, offset);
}

let rancherBootstrap = { state: 'idle', containerId: null }; // idle|running|done|failed

// Latest VS Code tunnel status, pushed by the closet pod's reporter (POST
// /tunnel) and read by the extension detail page (GET /tunnel). state is one of
// off|starting|auth|connected; auth carries a deviceUrl/deviceCode, connected a
// connectUrl + name.
let tunnelStatus = { state: 'off', updated: 0 };

// The host's externally-reachable IP, for Rancher's server-url. EC2 instance
// metadata first, then a public-IP echo service. Only SUCCESS is cached — a
// transient failure must not permanently strand server-url on the in-network
// fallback, so later bootstrap retries re-attempt detection until it resolves.
let publicHostCache;
async function detectPublicHost() {
  if (publicHostCache) return publicHostCache;
  const isIp = (t) => /^(\d{1,3}\.){3}\d{1,3}$/.test(t) || /^[0-9a-fA-F:]+$/.test(t);
  const get = async (url, opts, ms) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(ms), ...opts });
      if (!r.ok) return null;
      const t = (await r.text()).trim();
      return isIp(t) ? t : null;
    } catch { return null; }
  };
  let host = null;
  // EC2 IMDSv2: fetch a token, then the instance's public IPv4.
  const token = await get('http://169.254.169.254/latest/api/token',
    { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' } }, 1500);
  if (token) {
    host = await get('http://169.254.169.254/latest/meta-data/public-ipv4',
      { headers: { 'X-aws-ec2-metadata-token': token } }, 1500);
  }
  // Off-EC2: ask a public echo service what our egress IP is.
  if (!host) host = await get('https://checkip.amazonaws.com', {}, 4000);
  if (!host) host = await get('https://api.ipify.org', {}, 4000);
  if (host) publicHostCache = host;
  console.log(host ? `detected public host: ${host}` : 'could not detect public host yet (will retry; server-url stays in-network meanwhile)');
  return host || null;
}

// Warm the public-host cache at startup so the dev-server URL is available even
// before rancher is bootstrapped (defined here, after publicHostCache).
if (K8S) detectPublicHost();

// Scoped https JSON call that accepts rancher's self-signed cert (a global
// TLS override would also disable verification for Docker Hub/GitHub calls)
function rancherApi(pathname, { method = 'GET', token, body } = {}) {
  return new Promise((resolve) => {
    const req = https.request(`${sidecarApiUrl(RANCHER_URL, 'https', 'RANCHER_PORT', 44)}${pathname}`, {
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
    // server-url must be reachable from OUTSIDE this rancher, or clusters
    // provisioned inside the closet can't register — their cattle-cluster-agents
    // phone home to this URL, from the internet. The k8s node-IP NodePort is
    // the node's *internal* IP (status.hostIP), unreachable off-VPC — so use
    // the host's PUBLIC address instead: MC_PUBLIC_HOST override, else
    // auto-detected (EC2 IMDS, else a public-IP echo service), paired with
    // rancher's NodePort (k8s) or RANCHER_PORT (compose). Falls back to the
    // internal NodePort / in-network name only when no public host is found.
    const pubHost = env.MC_PUBLIC_HOST || await detectPublicHost();
    const ranPort = (K8S && k8sNodePortCache.get('rancher'))
      || parseInt(env.RANCHER_PORT, 10) || (parseInt(env.API_PORT, 10) || 8300) + 44;
    const serverUrl = (pubHost ? `https://${pubHost}:${ranPort}` : null)
      || k8sExternalUrl('rancher')
      || RANCHER_URL;
    await rancherApi('/v3/settings/server-url', { method: 'PUT', token, body: { value: serverUrl } });
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
// URL keycloak is reachable at from the browser AND from rancher's own
// backend. In k8s mode rancher runs inside the vcluster where the closet's
// service names don't resolve, so use the node-IP NodePort there (keycloak
// issues tokens with whatever host it was reached through, so any
// consistently-used URL works).
function kcPublicUrl() {
  return (K8S && k8sExternalUrl('keycloak')) || KEYCLOAK_URL;
}
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
    const resp = await fetch(`${sidecarApiUrl(KEYCLOAK_URL, 'http', 'KEYCLOAK_PORT', 30)}${pathname}`,
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
  const issuer = `${kcPublicUrl()}/realms/rancher`;
  const current = await rancherApi('/v3/keyCloakOIDCConfigs/keycloakoidc', { token });
  if (current.json?.enabled && current.json?.issuer === issuer) {
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
      issuer,
      authEndpoint: `${issuer}/protocol/openid-connect/auth`,
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

const ldapUrl = () => sidecarApiUrl('ldap://openldap:389', 'ldap', 'OPENLDAP_PORT', 40); // k8s: service DNS; compose: host port
const LDAP_BASE = 'dc=magic-closet,dc=local';
const LDAP_ADMIN_DN = `cn=admin,${LDAP_BASE}`;
let openldapBootstrap = { state: 'idle', containerId: null };

function ldapAdd(adminPassword, ldif) {
  try {
    execFileSync('ldapadd', ['-x', '-H', ldapUrl(), '-D', LDAP_ADMIN_DN, '-w', adminPassword],
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
        execFileSync('ldapsearch', ['-x', '-H', ldapUrl(), '-b', '', '-s', 'base'],
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
    // admin uses the Rancher bootstrap password so the same credentials work
    // on the "Log in with OpenLDAP" form (it's a regular LDAP user, though —
    // for global-admin access use "Use a local user").
    const users = [
      ['admin', env.RANCHER_BOOTSTRAP_PASSWORD, 'Admin', 'Admin'],
      ['user1', env.RANCHER_USER1_PASSWORD, 'User One', 'One'],
      ['user2', env.RANCHER_USER2_PASSWORD, 'User Two', 'Two'],
      ['user3', env.RANCHER_USER3_PASSWORD, 'User Three', 'Three'],
    ];
    for (const [uid, password, cn, sn] of users) {
      if (!password) continue;
      const result = ldapAdd(adminPw, [
        `dn: uid=${uid},ou=users,${LDAP_BASE}`,
        'objectClass: inetOrgPerson',
        `uid: ${uid}`,
        `cn: ${cn}`,
        `sn: ${sn}`,
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
  const dir = path.join(DATA_DIR, '.state', 'saml');
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
    const resp = await fetch(`${kcPublicUrl()}/realms/rancher/protocol/saml/descriptor`,
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
  if (K8S) return;
  if (!fs.existsSync('/workspace')) return; // not running in the workspace/root container
  const env = readEnvValues();
  // Default to rancher/dashboard master; set GITHUB_URL in .env to override
  // (a repo, PR, or issue URL).
  const url = env.GITHUB_URL || 'https://github.com/rancher/dashboard';
  if (cloneRunning) return;
  // The workspace is THIS (root) container now — /workspace is local.
  if (fs.existsSync('/workspace/dashboard')) return; // already cloned

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
  execFile('gosu', ['1000:1000', 'bash', '-c',
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

// In-cluster UI endpoints per sidecar (scheme + service port). `prefer`
// picks the link the dashboard shows: 'proxy' (Rancher service proxy,
// same-origin — for apps that tolerate a path prefix) or 'external'
// (node-IP NodePort — for apps that generate absolute URLs).
const K8S_PROXY_PORTS = {
  rancher: { scheme: 'https', port: 443, prefer: 'external' },
  keycloak: { scheme: 'http', port: 8080, prefer: 'external' },
  'rancher-browser': { scheme: 'https', port: 3001, prefer: 'external' },
  figma: { scheme: 'http', port: 8000, prefer: 'proxy' },
};

// In-network URL of a sidecar (compose service / k8s service DNS) — what the
// rancher-browser sidecar should browse to
function internalUrl(name) {
  const spec = K8S_PROXY_PORTS[name];
  if (!spec) return null;
  // Keycloak must be visited at the same origin rancher's OIDC config uses
  // (the NodePort URL in k8s mode) — otherwise the browser ends up with two
  // different keycloak origins and separate sessions
  if (name === 'keycloak' && K8S) {
    const ext = k8sExternalUrl(name);
    if (ext) return ext;
  }
  const defaultPort = (spec.scheme === 'https' && spec.port === 443) || (spec.scheme === 'http' && spec.port === 80);
  return `${spec.scheme}://${name}${defaultPort ? '' : `:${spec.port}`}`;
}

function k8sExternalUrl(name) {
  const spec = K8S_PROXY_PORTS[name];
  const nodePort = k8sNodePortCache.get(name);
  const nodeIp = process.env.NODE_IP;
  if (!spec || !nodePort || !nodeIp) return null;
  return `${spec.scheme}://${nodeIp}:${nodePort}`;
}

// Public URL of the dashboard dev server (https on :8005), reachable through
// the closet-external NodePort at the host's public address.
function devServerUrl() {
  if (!K8S) return null;
  const np = k8sNodePortCache.get('closet');
  const host = publicHostCache || process.env.NODE_IP;

  return (np && host) ? `https://${ host }:${ np }` : null;
}

// Sidecars that cannot run as pods (k8s mode only)
const K8S_UNSUPPORTED = {};

function handleList(res) {
  const env = readEnvValues();
  const sidecars = listSidecarDefs().map(s => {
    const state = containerStatus(s.name);
    return {
      ...s,
      status: state.status,
      health: state.health,
      hostPort: (!K8S && s.port) ? env[s.port] || null : null,
      proxy: K8S ? K8S_PROXY_PORTS[s.name] || null : null,
      external: K8S ? k8sExternalUrl(s.name) : null,
      internal: internalUrl(s.name),
      unsupported: (K8S && K8S_UNSUPPORTED[s.name]) || null,
      params: s.params.map(p => ({ ...p, value: env[p.env] ?? p.default })),
      ...(s.name === 'rancher' ? { bootstrap: rancherBootstrap.state } : {}),
      ...(s.name === 'keycloak' ? { bootstrap: keycloakBootstrap.state } : {}),
      ...(s.name === 'openldap' ? { bootstrap: openldapBootstrap.state } : {}),
    };
  });
  sendJson(res, 200, {
    sidecars,
    rancher: {
      running: containerStatus('rancher').status === 'running',
      authProvider: selectedAuthProvider(),
    },
    dev: { url: devServerUrl() },
  });
}

// Apply an auth sidecar's provider mode to Rancher (persists the selection so
// bootstraps keep re-applying it after restarts)
const AUTH_CONNECTORS = {
  'keycloak': () => connectRancherToKeycloak(),
  'keycloak-saml': () => connectRancherToKeycloakSaml(),
  'openldap': () => connectRancherToOpenLdap(),
};

// Host-port offset table: every host port derives from API_PORT by these
// offsets (see readEnvValues). API_PORT itself is the api/dashboard port.
const PORT_OFFSETS = {
  API_PORT:             0,
  API_HTTPS_PORT:       1,
  DEV_PORT:             5,
  VSCODE_PORT:          10,
  RANCHER_BROWSER_PORT: 20,
  KEYCLOAK_PORT:        30,
  OPENLDAP_PORT:        40,
  RANCHER_PORT:         44,
  FIGMA_PORT:           60,
};

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

  if (K8S) {
    k8sApi(`/apis/apps/v1/namespaces/${K8S.ns}/deployments/${name}`, {
      method: 'PATCH',
      contentType: 'application/strategic-merge-patch+json',
      body: {
        spec: {
          replicas: 1,
          template: { metadata: { annotations: { 'magic-closet/restarted-at': new Date().toISOString() } } },
        },
      },
    }).then(({ status }) => {
      if (status >= 200 && status < 300) {
        if (name === 'rancher' && rancherBootstrap.state !== 'running') { rancherBootstrap = { state: 'idle', containerId: null }; bootstrapRancher(); }
        if (name === 'keycloak' && keycloakBootstrap.state !== 'running') { keycloakBootstrap = { state: 'idle', containerId: null }; bootstrapKeycloak(); }
        if (name === 'openldap' && openldapBootstrap.state !== 'running') { openldapBootstrap = { state: 'idle', containerId: null }; bootstrapOpenLdap(); }
        sendJson(res, 200, { status: 'started', sidecar: name, params: updates });
      } else {
        sendJson(res, 500, { error: `scale failed (HTTP ${status})` });
      }
    });
    return;
  }

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
    sendJson(res, 200, { status: 'started', sidecar: name, params: updates, containerStatus: containerStatus(name) });
  }, sidecarFiles(def));
}

function handleStop(name, res) {
  const def = getSidecarDef(name);
  if (!def) return sendJson(res, 404, { error: `unknown sidecar: ${name}` });
  if (K8S) {
    k8sApi(`/apis/apps/v1/namespaces/${K8S.ns}/deployments/${name}`, {
      method: 'PATCH', contentType: 'application/strategic-merge-patch+json', body: { spec: { replicas: 0 } },
    }).then(({ status }) => {
      sendJson(res, status < 300 ? 200 : 500, { status: status < 300 ? 'stopped' : 'error', sidecar: name });
    });
    return;
  }
  compose(['--profile', name, 'stop', name], (err, stdout, stderr) => {
    if (err) return sendJson(res, 500, { error: 'compose stop failed', detail: stderr.trim() });
    sendJson(res, 200, { status: 'stopped', sidecar: name });
  }, sidecarFiles(def));
}

function handleDelete(name, res) {
  const def = getSidecarDef(name);
  if (!def) return sendJson(res, 404, { error: `unknown sidecar: ${name}` });
  if (K8S) return handleStop(name, res); // in-cluster: delete == scale to 0
  compose(['--profile', name, 'rm', '-sf', name], (err, stdout, stderr) => {
    if (err) return sendJson(res, 500, { error: 'compose rm failed', detail: stderr.trim() });
    sendJson(res, 200, { status: 'deleted', sidecar: name });
  }, sidecarFiles(def));
}

function handleLogs(name, params, res) {
  const def = getSidecarDef(name);
  if (!def) return sendJson(res, 404, { error: `unknown sidecar: ${name}` });
  if (K8S) return sendJson(res, 200, { logs: '(sidecar logs are compose-mode only; use Rancher/kubectl in-cluster)' });
  const tail = Math.min(parseInt(params.get('tail'), 10) || 500, 5000);
  const id = containerIdOf(name);
  if (!id) return sendJson(res, 200, { logs: '(no container — sidecar not created)' });
  execFile('docker', ['logs', '--tail', String(tail), '--timestamps', id],
    { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, timeout: 15000 },
    (err, stdout, stderr) => {
      // container stdout + stderr (docker keeps them on separate streams)
      const out = `${stdout || ''}${stderr || ''}`.trim();
      sendJson(res, 200, { logs: out || '(no output yet)' });
    });
}

// Live logs: stream `docker logs -f` over a chunked response. The child is
// killed when the client disconnects (closes the modal / navigates away).
function handleLogsStream(name, params, res) {
  const def = getSidecarDef(name);
  if (!def) return sendJson(res, 404, { error: `unknown sidecar: ${name}` });
  res.writeHead(200, {
    'Content-Type':  'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // don't let any proxy buffer the stream
  });
  if (K8S) return res.end('(sidecar logs are compose-mode only; use Rancher/kubectl in-cluster)');
  const tail = Math.min(parseInt(params.get('tail'), 10) || 1000, 5000);
  const id = containerIdOf(name);
  if (!id) return res.end('(no container — sidecar not created)');
  const child = spawn('docker', ['logs', '-f', '--tail', String(tail), '--timestamps', id]);
  child.stdout.on('data', (d) => res.write(d));
  child.stderr.on('data', (d) => res.write(d));
  child.on('error', (e) => { try { res.end(`\n[logs error: ${ e.message }]`); } catch { /* closed */ } });
  child.on('close', () => { try { res.end(); } catch { /* closed */ } });
  res.on('close', () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
}

// ---------- custom sidecar definitions (created/edited from within a closet) ----------
//
// A spec ({name, image|compose, port, containerPort, params, secrets, ...}) is
// written to custom-sidecars/<name>/ as a compose fragment + sidecar.json. It's
// discovered like any built-in and (living under MC_ROOT) is inherited by every
// future compose closet. A custom name shadows a built-in of the same name.

const SIDECAR_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

function specToFragment(spec) {
  const svc = {
    profiles: [spec.name],
    env_file: [{ path: '${MC_ENV_FILE:-./.env}', required: false }],
    restart: 'unless-stopped',
  };
  if (spec.image) svc.image = spec.image;
  if (spec.command !== undefined) svc.command = spec.command;
  if (spec.environment && typeof spec.environment === 'object') {
    svc.environment = Object.entries(spec.environment).map(([k, v]) => `${k}=${v}`);
  }
  if (Array.isArray(spec.volumes)) svc.volumes = spec.volumes;
  // Publish a host port only when asked; otherwise it's reachable in-network by
  // service name (host access needs the port to fall in the DinD wrapper's range)
  if (spec.containerPort && (spec.port || spec.hostPort)) {
    const host = spec.port
      ? `\${${spec.port}:-${spec.hostPort || spec.containerPort}}`
      : String(spec.hostPort);
    svc.ports = [`${host}:${spec.containerPort}`];
  }
  Object.assign(svc, spec.compose || {}); // advanced raw compose overrides win
  return { services: { [spec.name]: svc } };
}

function specToMeta(spec) {
  const meta = { name: spec.name, description: spec.description || '' };
  if (spec.group) meta.group = spec.group;
  if (spec.port) meta.port = spec.port;
  if (spec.scheme) meta.scheme = spec.scheme;
  if (Array.isArray(spec.params)) meta.params = spec.params;
  if (Array.isArray(spec.secrets)) meta.secrets = spec.secrets;
  return meta;
}

function validateSidecarSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'body must be a JSON object';
  if (!SIDECAR_NAME_RE.test(spec.name || '')) return 'name must match [a-z0-9][a-z0-9-]{0,38}';
  if (!spec.image && !spec.compose) return 'provide an "image" (or raw "compose" overrides)';
  return null;
}

function handleSidecarWrite(spec, res, editing) {
  if (K8S) return sendJson(res, 501, { error: 'custom sidecars are compose-mode only' });
  const err = validateSidecarSpec(spec);
  if (err) return sendJson(res, 400, { error: err });
  const dir = path.join(CUSTOM_SIDECARS_DIR, spec.name);
  const exists = fs.existsSync(path.join(dir, 'compose.yml'));
  if (!editing && exists) return sendJson(res, 409, { error: `custom sidecar '${spec.name}' already exists (use PUT to edit)` });
  try {
    fs.mkdirSync(dir, { recursive: true });
    // JSON is valid YAML, so a JSON-shaped compose.yml parses fine and diffs cleanly
    fs.writeFileSync(path.join(dir, 'compose.yml'), `${JSON.stringify(specToFragment(spec), null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'sidecar.json'), `${JSON.stringify(specToMeta(spec), null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'spec.json'), `${JSON.stringify(spec, null, 2)}\n`); // lets edits round-trip
  } catch (e) {
    return sendJson(res, 500, { error: `failed to write sidecar: ${e.message}` });
  }
  ensureGeneratedSecrets(); // generate any secrets the new sidecar declares
  return sendJson(res, editing ? 200 : 201, {
    status: editing ? 'updated' : 'created',
    sidecar: spec.name,
    shadowsBuiltin: listBuiltinNames().includes(spec.name),
    note: 'start with POST /sidecars/<name>/start; inherited by future compose closets',
  });
}

function handleSidecarDeleteDef(name, res) {
  const dir = path.join(CUSTOM_SIDECARS_DIR, name);
  if (!fs.existsSync(path.join(dir, 'compose.yml'))) {
    return sendJson(res, 404, { error: `no custom definition for '${name}'` });
  }
  const def = getSidecarDef(name);
  const finish = () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { return sendJson(res, 500, { error: `failed to remove: ${e.message}` }); }
    sendJson(res, 200, { status: 'removed', sidecar: name, revertsToBuiltin: listBuiltinNames().includes(name) });
  };
  // best-effort remove any running container first, then drop the definition
  if (def) compose(['--profile', name, 'rm', '-sf', name], () => finish(), sidecarFiles(def));
  else finish();
}

function handleExec(body, res) {
  if (K8S) return sendJson(res, 501, { error: 'project exec is not supported in kubernetes mode yet' });
  if (!body.command) return sendJson(res, 400, { error: 'missing "command"' });
  // The workspace is THIS (root) container now — run locally as the node user.
  execFile('gosu', ['1000:1000', 'bash', '-lc', body.command],
    { cwd: fs.existsSync('/workspace') ? '/workspace' : undefined, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, timeout: (body.timeoutSeconds || 300) * 1000 },
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

const handler = (async (req, res) => {
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
    if (req.method === 'POST' && url.pathname === '/sidecars') {
      return handleSidecarWrite(await readBody(req), res, false);
    }
    if (parts[0] === 'sidecars' && parts[1]) {
      const name = parts[1];
      if (req.method === 'PUT' && parts.length === 2) {
        return handleSidecarWrite({ ...(await readBody(req)), name }, res, true);
      }
      if (req.method === 'DELETE' && parts[2] === 'definition') {
        return handleSidecarDeleteDef(name, res);
      }
      if (req.method === 'GET' && parts[2] === 'params' && parts[3] && parts[4] === 'options') {
        return handleParamOptions(name, parts[3], res);
      }
      if (req.method === 'GET' && parts[2] === 'logs' && parts[3] === 'stream') {
        return handleLogsStream(name, url.searchParams, res);
      }
      if (req.method === 'GET' && parts[2] === 'logs') {
        return handleLogs(name, url.searchParams, res);
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
    if (req.method === 'POST' && (url.pathname === '/exec' || url.pathname === '/project/exec')) {
      return handleExec(await readBody(req), res);
    }
    if (req.method === 'POST' && url.pathname === '/auth/apply') {
      return handleAuthApply(await readBody(req), res);
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
    // VS Code tunnel: the closet pod reports its state here; the detail page
    // reads it to show the device-login code / connect link.
    if (req.method === 'POST' && url.pathname === '/tunnel') {
      const body = await readBody(req);

      tunnelStatus = {
        state:      body.state || 'off',
        deviceUrl:  body.deviceUrl || '',
        deviceCode: body.deviceCode || '',
        connectUrl: body.connectUrl || '',
        name:       body.name || '',
        updated:    Date.now(),
      };

      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/tunnel') {
      return sendJson(res, 200, { ...tunnelStatus, stale: Date.now() - (tunnelStatus.updated || 0) > 20000 });
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
ensureWorkspaceClone();

http.createServer(handler).listen(PORT, () => {
  console.log(`magic-closet api listening on :${PORT} (root: ${MC_ROOT})`);
});

// HTTPS with a self-signed cert (generated once into .state/api-tls) — an
// https dashboard (e.g. Rancher hosting the extension) cannot call a plain
// http API without mixed-content blocking. Browsers must trust or ignore the
// cert (the browser sidecars run with --ignore-certificate-errors).
function ensureApiTls() {
  const dir = path.join(DATA_DIR, '.state', 'api-tls');
  const keyPath = path.join(dir, 'key.pem');
  const crtPath = path.join(dir, 'crt.pem');
  if (!fs.existsSync(keyPath) || !fs.existsSync(crtPath)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', crtPath, '-days', '3650', '-subj', '/CN=magic-closet-api'],
      { stdio: 'ignore' });
    console.log('generated api TLS cert (.state/api-tls)');
  }
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(crtPath) };
}

try {
  https.createServer(ensureApiTls(), handler).listen(HTTPS_PORT, () => {
    console.log(`magic-closet api also listening on :${HTTPS_PORT} (https, self-signed)`);
  });
} catch (err) {
  console.error(`https listener failed: ${err.message}`);
}
