// Rancher-native closet management: a closet is an install of the "closet"
// Helm chart in a closet-<name> namespace. Everything goes through the
// Rancher API same-origin — no external controller, no extra config.

let clusterId = 'local';

export function setCluster(cluster: string): void {
  clusterId = cluster || 'local';
}

function base(): string {
  return `/k8s/clusters/${ clusterId }`;
}

function csrfHeader(): Record<string, string> {
  const match = document.cookie.match(/(?:^|;\s*)CSRF=([^;]*)/);

  return { 'X-Api-Csrf': match ? decodeURIComponent(match[1]) : 'CSRF' };
}

export async function rancherFetch(path: string, init?: RequestInit): Promise<any> {
  const write = init?.method && init.method !== 'GET';
  const resp = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      ...(write ? csrfHeader() : {}),
      ...(init?.headers || {}),
    },
  });
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(data.message || data.error || `HTTP ${ resp.status }`);
  }

  return data;
}

// Same-origin service-proxy path to a closet's own api/dashboard
export function closetApiBase(namespace: string): string {
  return `${ base() }/api/v1/namespaces/${ namespace }/services/http:api:8080/proxy`;
}

export async function listClosets(): Promise<any[]> {
  const data = await rancherFetch(`${ base() }/v1/catalog.cattle.io.apps`);

  return (data.data || [])
    .filter((a: any) => a.spec?.chart?.metadata?.name === 'closet')
    .map((a: any) => ({
      name:      a.spec?.name || a.metadata?.name,
      namespace: a.metadata?.namespace,
      state:     a.metadata?.state?.name || a.status?.summary?.state || '—',
      version:   a.spec?.chart?.metadata?.version,
    }));
}

export async function findClosetChart(): Promise<{ repo: string; version: string }> {
  const repos = await rancherFetch(`${ base() }/v1/catalog.cattle.io.clusterrepos`);

  for (const r of repos.data || []) {
    try {
      const idx = await rancherFetch(`${ base() }/v1/catalog.cattle.io.clusterrepos/${ r.metadata.name }?link=index`);
      const versions = idx.entries?.closet;

      if (versions?.length) {
        return { repo: r.metadata.name, version: versions[0].version };
      }
    } catch { /* skip unreadable repo */ }
  }
  throw new Error('No repository provides the "closet" chart — add https://codyrancher.github.io/magic-closet/ in Apps → Repositories');
}

export async function createCloset(name: string, sidecars: Record<string, boolean>, config: Record<string, string> = {}): Promise<void> {
  const { repo, version } = await findClosetChart();
  const namespace = `closet-${ name }`;

  try {
    await rancherFetch(`${ base() }/v1/namespaces`, {
      method: 'POST',
      body:   JSON.stringify({ type: 'namespace', metadata: { name: namespace } }),
    });
  } catch { /* already exists */ }

  await rancherFetch(`${ base() }/v1/catalog.cattle.io.clusterrepos/${ repo }?action=install`, {
    method: 'POST',
    body:   JSON.stringify({
      namespace,
      charts: [{
        chartName:   'closet',
        version,
        releaseName: name,
        annotations: {
          'catalog.cattle.io/ui-source-repo-type': 'cluster',
          'catalog.cattle.io/ui-source-repo':      repo,
        },
        values: Object.keys(config).length ? { sidecars, config } : { sidecars },
      }],
    }),
  });
}

export async function deleteCloset(closet: any): Promise<void> {
  await rancherFetch(`${ base() }/v1/catalog.cattle.io.apps/${ closet.namespace }/${ closet.name }?action=uninstall`, {
    method: 'POST',
    body:   '{}',
  });
  // The closet owns its namespace; deleting it also cleans up anything the
  // chart didn't create directly (e.g. the rancher sidecar's vcluster)
  if (closet.namespace?.startsWith('closet-')) {
    await rancherFetch(`${ base() }/v1/namespaces/${ closet.namespace }`, { method: 'DELETE' }).catch(() => null);
  }
}

// ---------- secret sets (per-user, reused across closets) ----------
//
// A secret set is a named bundle of key->value secrets, stored as a single
// k8s Secret in the magic-closet-secrets namespace, labeled with the owning
// Rancher user so sets are scoped per-user. One set can be the default.

export const SECRETS_NS = 'magic-closet-secrets';

const LBL_KIND = 'magic-closet.io/kind';
const LBL_OWNER = 'magic-closet.io/owner';
const LBL_DEFAULT = 'magic-closet.io/default';
const ANN_NAME = 'magic-closet.io/display-name';

function sanitize(v: string): string {
  return (v || '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).toLowerCase() || 'x';
}

let ownerId = 'anonymous';

export function setSecretOwner(principalId: string): void {
  ownerId = sanitize(principalId || 'anonymous');
}

function secretName(displayName: string): string {
  return `set-${ ownerId }-${ sanitize(displayName) }`.slice(0, 253);
}

export interface SecretSet { name: string; isDefault: boolean; keys: string[]; }

export async function listSecretSets(): Promise<SecretSet[]> {
  try {
    // Steve's /v1/secrets ignores labelSelector, so filter client-side by
    // our kind + owner labels
    const data = await rancherFetch(`${ base() }/v1/secrets/${ SECRETS_NS }`);

    return (data.data || [])
      .filter((sec: any) => sec.metadata?.labels?.[LBL_KIND] === 'secret-set' && sec.metadata?.labels?.[LBL_OWNER] === ownerId)
      .map((sec: any) => ({
        name:      sec.metadata?.annotations?.[ANN_NAME] || sec.metadata?.name,
        isDefault: sec.metadata?.labels?.[LBL_DEFAULT] === 'true',
        keys:      Object.keys(sec.data || {}),
      }))
      .sort((a: SecretSet, b: SecretSet) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function readSecretSet(displayName: string): Promise<Record<string, string>> {
  const sec = await rancherFetch(`${ base() }/v1/secrets/${ SECRETS_NS }/${ secretName(displayName) }`);
  const out: Record<string, string> = {};

  for (const [k, v] of Object.entries(sec.data || {})) {
    out[k] = v ? atob(v as string) : '';
  }

  return out;
}

export async function saveSecretSet(displayName: string, values: Record<string, string>, isDefault: boolean): Promise<void> {
  try {
    await rancherFetch(`${ base() }/v1/namespaces`, {
      method: 'POST',
      body:   JSON.stringify({ type: 'namespace', metadata: { name: SECRETS_NS } }),
    });
  } catch { /* already exists */ }

  // Only one default per user — clear it on the others first
  if (isDefault) {
    for (const set of await listSecretSets()) {
      if (set.name !== displayName && set.isDefault) {
        await patchSecretDefault(set.name, false);
      }
    }
  }

  const data: Record<string, string> = {};

  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined && v !== null && v !== '') {
      data[k] = btoa(v);
    }
  }

  const body = {
    type:     'secret',
    _type:    'Opaque',
    metadata: {
      namespace:   SECRETS_NS,
      name:        secretName(displayName),
      labels:      { [LBL_KIND]: 'secret-set', [LBL_OWNER]: ownerId, [LBL_DEFAULT]: isDefault ? 'true' : 'false' },
      annotations: { [ANN_NAME]: displayName },
    },
    data,
  };

  // Upsert
  const existing = await rancherFetch(`${ base() }/v1/secrets/${ SECRETS_NS }/${ secretName(displayName) }`).catch(() => null);

  if (existing) {
    await rancherFetch(`${ base() }/v1/secrets/${ SECRETS_NS }/${ secretName(displayName) }`, { method: 'PUT', body: JSON.stringify(body) });
  } else {
    await rancherFetch(`${ base() }/v1/secrets`, { method: 'POST', body: JSON.stringify(body) });
  }
}

async function patchSecretDefault(displayName: string, isDefault: boolean): Promise<void> {
  const sec = await rancherFetch(`${ base() }/v1/secrets/${ SECRETS_NS }/${ secretName(displayName) }`);

  sec.metadata.labels = { ...(sec.metadata.labels || {}), [LBL_DEFAULT]: isDefault ? 'true' : 'false' };
  await rancherFetch(`${ base() }/v1/secrets/${ SECRETS_NS }/${ secretName(displayName) }`, { method: 'PUT', body: JSON.stringify(sec) });
}

// Make one set the user's default, clearing the flag on whichever set had it
export async function setSecretSetDefault(displayName: string): Promise<void> {
  for (const set of await listSecretSets()) {
    if (set.name !== displayName && set.isDefault) {
      await patchSecretDefault(set.name, false);
    }
  }
  await patchSecretDefault(displayName, true);
}

export async function deleteSecretSet(displayName: string): Promise<void> {
  await rancherFetch(`${ base() }/v1/secrets/${ SECRETS_NS }/${ secretName(displayName) }`, { method: 'DELETE' }).catch(() => null);
}
