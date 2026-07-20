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

export async function createCloset(name: string, sidecars: Record<string, boolean>): Promise<void> {
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
        values: { sidecars },
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

// ---------- shared secrets (reused across closets) ----------

export const SECRETS_NS = 'magic-closet-secrets';

export async function listSharedSecrets(): Promise<string[]> {
  try {
    const data = await rancherFetch(`${ base() }/v1/secrets/${ SECRETS_NS }`);

    return (data.data || []).map((s: any) => s.metadata?.name).filter(Boolean).sort();
  } catch {
    return [];
  }
}

export async function readSharedSecret(name: string): Promise<string> {
  const s = await rancherFetch(`${ base() }/v1/secrets/${ SECRETS_NS }/${ name }`);
  const b64 = s.data?.value || (Object.values(s.data || {})[0] as string) || '';

  return b64 ? atob(b64) : '';
}

export async function createSharedSecret(name: string, value: string): Promise<void> {
  try {
    await rancherFetch(`${ base() }/v1/namespaces`, {
      method: 'POST',
      body:   JSON.stringify({ type: 'namespace', metadata: { name: SECRETS_NS } }),
    });
  } catch { /* already exists */ }

  await rancherFetch(`${ base() }/v1/secrets`, {
    method: 'POST',
    body:   JSON.stringify({
      type:     'secret',
      _type:    'Opaque',
      metadata: { namespace: SECRETS_NS, name },
      data:     { value: btoa(value) },
    }),
  });
}
