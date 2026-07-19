// Where the magic-closet control API lives. Persisted per-browser; the
// default guesses based on how the dashboard is being accessed: through the
// rancher-browser sidecar (https://rancher) the API is on the compose
// network, otherwise assume the standard host port.
const STORAGE_KEY = 'magic-closet-api-url';

export function defaultApiUrl(): string {
  if (window.location.hostname === 'rancher') {
    return 'http://api:8080';
  }

  return `http://${ window.location.hostname }:8300`;
}

export function getApiUrl(): string {
  return window.localStorage.getItem(STORAGE_KEY) || defaultApiUrl();
}

export function setApiUrl(url: string): void {
  window.localStorage.setItem(STORAGE_KEY, url);
}

// A closet's own API/dashboard: same host as the controller, its own port.
// When the controller is reached via its compose-internal name (viewing
// through the rancher-browser), other closets' host ports are only reachable
// via the docker bridge gateway.
export function closetUrl(closet: any, hostGateway?: string): string {
  let host = new URL(getApiUrl()).hostname;

  if (host === 'api' && hostGateway) {
    host = hostGateway;
  }

  return `http://${ host }:${ closet.apiPort }`;
}

export async function apiFetch(pathname: string, init?: RequestInit): Promise<any> {
  const resp = await fetch(`${ getApiUrl() }${ pathname }`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(data.error || `${ resp.status }`);
  }

  return data;
}
