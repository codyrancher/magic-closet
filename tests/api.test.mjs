// Integration tests for the magic-closet control API. Boots the real server
// with docker + fetch mocked (see harness.mjs), then exercises each feature
// over HTTP and asserts responses + side effects (.env writes, compose commands,
// generated files). Run: tests/run.sh   (or `node --test tests/`).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './harness.mjs';

after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref());

describe('health & static', () => {
  it('GET /health → 200', async () => {
    const r = await h.api('GET', '/health');
    assert.equal(r.status, 200);
  });
  it('GET / serves the dashboard', async () => {
    const r = await h.api('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.text, /magic closet/);
  });
  it('GET /favicon.svg → 200', async () => {
    const r = await h.api('GET', '/favicon.svg');
    assert.equal(r.status, 200);
  });
});

describe('sidecar discovery — GET /sidecars', () => {
  let list;
  before(async () => { list = (await h.api('GET', '/sidecars')).json.sidecars; });

  it('discovers every built-in sidecar', () => {
    const names = list.map((s) => s.name).sort();
    for (const n of ['figma', 'keycloak', 'openldap', 'rancher', 'rancher-browser', 'vscode']) {
      assert.ok(names.includes(n), `missing sidecar: ${n}`);
    }
  });
  it('derives host ports from API_PORT (8300 → vscode 8310, rancher 8344, keycloak 8330)', () => {
    const by = Object.fromEntries(list.map((s) => [s.name, s]));
    assert.equal(by.vscode.hostPort, '8310');
    assert.equal(by.rancher.hostPort, '8344');
    assert.equal(by.keycloak.hostPort, '8330');
  });
  it('reports scheme + params + rancherAuth', () => {
    const by = Object.fromEntries(list.map((s) => [s.name, s]));
    assert.equal(by.vscode.scheme, 'https');
    assert.deepEqual(by.rancher.params.map((p) => p.id), ['tag', 'prime']);
    assert.ok(by.keycloak.rancherAuth, 'keycloak should declare rancherAuth');
  });
  it('reflects container running state from (mock) docker', async () => {
    h.setRunning();               // nothing running
    let r = await h.api('GET', '/sidecars');
    assert.equal(r.json.rancher.running, false);
    h.setRunning('rancher');      // rancher up
    r = await h.api('GET', '/sidecars');
    assert.equal(r.json.rancher.running, true);
    h.setRunning();
  });
});

describe('generated secrets', () => {
  it('are written to .state/secrets.env at boot, not .env', () => {
    const secrets = h.readSecrets();
    for (const k of ['RANCHER_BOOTSTRAP_PASSWORD', 'RANCHER_USER1_PASSWORD',
      'KEYCLOAK_ADMIN_PASSWORD', 'OPENLDAP_ADMIN_PASSWORD']) {
      assert.match(secrets, new RegExp(`^${k}=.+`, 'm'), `secret ${k} not generated`);
    }
    assert.doesNotMatch(h.readEnv(), /RANCHER_BOOTSTRAP_PASSWORD=/, 'secret leaked into .env');
  });
});

describe('sidecar lifecycle', () => {
  it('start persists params and issues `compose up -d`', async () => {
    h.clearDockerLog();
    const r = await h.api('POST', '/sidecars/rancher/start', { params: { tag: 'v2.14.3' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.params.RANCHER_TAG, 'v2.14.3');
    assert.match(h.readEnv(), /^RANCHER_TAG=v2\.14\.3$/m);
    assert.match(h.dockerLog(), /--profile rancher up -d rancher/);
  });
  it('start rejects an unknown param → 400', async () => {
    const r = await h.api('POST', '/sidecars/rancher/start', { params: { nope: '1' } });
    assert.equal(r.status, 400);
    assert.ok(r.json.accepted.includes('tag'));
  });
  it('start rejects an unknown sidecar → 404', async () => {
    assert.equal((await h.api('POST', '/sidecars/ghost/start', {})).status, 404);
  });
  it('stop issues `compose stop`', async () => {
    h.clearDockerLog();
    const r = await h.api('POST', '/sidecars/figma/stop');
    assert.equal(r.status, 200);
    assert.match(h.dockerLog(), /stop figma/);
  });
  it('delete issues `compose rm -sf`', async () => {
    h.clearDockerLog();
    const r = await h.api('DELETE', '/sidecars/figma');
    assert.equal(r.status, 200);
    assert.match(h.dockerLog(), /rm -sf figma/);
  });
});

describe('exec — POST /exec', () => {
  it('409 when the workspace container is not running', async () => {
    h.setRunning();
    assert.equal((await h.api('POST', '/exec', { command: 'echo hi' })).status, 409);
  });
  it('runs a command in the workspace container', async () => {
    h.setRunning('workspace');
    const r = await h.api('POST', '/exec', { command: 'echo hi' });
    assert.equal(r.status, 200);
    assert.equal(r.json.exitCode, 0);
    assert.match(r.json.stdout, /mock-exec: echo hi/);
  });
  it('/project/exec is an alias', async () => {
    h.setRunning('workspace');
    assert.equal((await h.api('POST', '/project/exec', { command: 'ls' })).status, 200);
  });
  it('400 without a command', async () => {
    assert.equal((await h.api('POST', '/exec', {})).status, 400);
    h.setRunning();
  });
});

describe('param options — GET /sidecars/<name>/params/<id>/options', () => {
  it('rancher tag → actual GA releases only, newest first', async () => {
    const r = await h.api('GET', '/sidecars/rancher/params/tag/options');
    assert.equal(r.status, 200);
    const vals = r.json.options.map((o) => o.value);
    assert.deepEqual(vals, ['v2.14.3', 'v2.14.2', 'v2.13.7']); // rc + non-semver filtered
  });
  it('a param without options → []', async () => {
    const r = await h.api('GET', '/sidecars/rancher/params/prime/options');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.options, []);
  });
  it('unknown param → 404', async () => {
    assert.equal((await h.api('GET', '/sidecars/rancher/params/ghost/options')).status, 404);
  });
});

describe('closets controller', () => {
  it('lists the local closet', async () => {
    const r = await h.api('GET', '/closets');
    assert.equal(r.status, 200);
    assert.ok(JSON.stringify(r.json).includes('magic-closet'));
  });
  it('create writes an env file with derived ports + secrets, and provisions', async () => {
    h.clearDockerLog();
    const r = await h.api('POST', '/closets', { name: 'testclo' });
    assert.equal(r.status, 202);
    assert.ok(h.exists('.state/closets/testclo.env'));
    const env = h.readFile('.state/closets/testclo.env');
    assert.match(env, /^MC_PROJECT=mc-testclo$/m);
    assert.match(env, /^API_PORT=8500$/m);
    assert.match(env, /^VSCODE_PORT=8510$/m);
    assert.match(env, /^RANCHER_BOOTSTRAP_PASSWORD=.+/m);
  });
  it('rejects an invalid name → 400', async () => {
    assert.equal((await h.api('POST', '/closets', { name: 'Bad Name' })).status, 400);
  });
  it('delete accepts (202) and removes the env file', async () => {
    const r = await h.api('DELETE', '/closets/testclo');
    assert.equal(r.status, 202); // provisioning/teardown is async
    assert.ok(await h.waitFor(() => !h.exists('.state/closets/testclo.env')), 'env file not removed');
  });
});

describe('custom sidecars', () => {
  const spec = { name: 'mytool', image: 'redis:7', description: 'a cache', port: 'MYTOOL_PORT', containerPort: 6379 };
  it('create writes compose.yml + sidecar.json + spec.json', async () => {
    const r = await h.api('POST', '/sidecars', spec);
    assert.equal(r.status, 201);
    for (const f of ['compose.yml', 'sidecar.json', 'spec.json']) {
      assert.ok(h.exists(`custom-sidecars/mytool/${f}`), `missing ${f}`);
    }
    const list = (await h.api('GET', '/sidecars')).json.sidecars.map((s) => s.name);
    assert.ok(list.includes('mytool'), 'custom sidecar not discovered');
  });
  it('creating the same one again → 409', async () => {
    assert.equal((await h.api('POST', '/sidecars', spec)).status, 409);
  });
  it('edit (PUT) updates the definition', async () => {
    const r = await h.api('PUT', '/sidecars/mytool', { ...spec, description: 'edited' });
    assert.equal(r.status, 200);
    assert.match(h.readFile('custom-sidecars/mytool/sidecar.json'), /edited/);
  });
  it('an invalid spec → 400', async () => {
    assert.equal((await h.api('POST', '/sidecars', { name: 'x' }) /* no image/compose */).status, 400);
  });
  it('delete definition removes the dir', async () => {
    const r = await h.api('DELETE', '/sidecars/mytool/definition');
    assert.equal(r.status, 200);
    assert.equal(h.exists('custom-sidecars/mytool'), false);
  });
});

describe('auth apply — POST /auth/apply', () => {
  it('unknown provider → 400 with the accepted list', async () => {
    const r = await h.api('POST', '/auth/apply', { provider: 'nope' });
    assert.equal(r.status, 400);
    assert.ok(Array.isArray(r.json.accepted) && r.json.accepted.length);
  });
  it('409 when rancher is not running', async () => {
    h.setRunning();
    assert.equal((await h.api('POST', '/auth/apply', { provider: 'keycloak' })).status, 409);
  });
  it('persists RANCHER_AUTH_PROVIDER when rancher is running', async () => {
    h.setRunning('rancher');
    await h.api('POST', '/auth/apply', { provider: 'keycloak' }); // rancher call fails → 500, but env is written first
    assert.match(h.readEnv(), /^RANCHER_AUTH_PROVIDER=keycloak$/m);
    h.setRunning();
  });
});

describe('browser tabs', () => {
  it('open queues when the browser is down, and appears in the queue', async () => {
    const r = await h.api('POST', '/browser/open', { url: 'https://rancher' });
    assert.equal(r.status, 202); // cdp unreachable → queued
    const q = await h.api('GET', '/browser/queue');
    assert.ok(JSON.stringify(q.json).includes('https://rancher'));
  });
  it('400 without a url', async () => {
    assert.equal((await h.api('POST', '/browser/open', {})).status, 400);
  });
});
