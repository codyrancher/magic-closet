// Where the magic-closet control API lives. Persisted per-browser; the
// default guesses based on how the dashboard is being accessed: through the
// rancher-browser sidecar (https://rancher) the API is on the compose
// network, otherwise assume the standard host port.
const STORAGE_KEY = 'magic-closet-api-url';
const SETTING_URL = '/v1/management.cattle.io.settings/magic-closet-controller';

let cachedUrl: string | null = null;

export function defaultApiUrl(): string {
  if (window.location.hostname === 'rancher') {
    return 'http://api:8080';
  }

  return `http://${ window.location.hostname }:8300`;
}

export function getApiUrl(): string {
  return cachedUrl || window.localStorage.getItem(STORAGE_KEY) || defaultApiUrl();
}

// Priority: personal localStorage override > the Rancher-wide
// "magic-closet-controller" Setting > a guess. Call once before using the
// api; result is cached for the synchronous helpers.
export async function resolveApiUrl(): Promise<string> {
  const stored = window.localStorage.getItem(STORAGE_KEY);

  // A stored value that is just the unconfigured default (e.g. saved by
  // accident before the controller was reachable) shouldn't shadow the
  // Rancher-wide Setting
  if (stored && stored !== defaultApiUrl()) {
    cachedUrl = stored;

    return stored;
  }

  // Baked in at install time: helm value plugin.metadata.controller on this
  // extension's own UIPlugin resource (readable by every dashboard user)
  try {
    const resp = await fetch('/v1/uiplugins');

    if (resp.ok) {
      const index = await resp.json();
      const controller = index.entries?.['magic-closet']?.metadata?.controller;

      if (controller) {
        cachedUrl = controller;

        return controller;
      }
    }
  } catch { /* not installed via chart — fall through */ }

  try {
    const resp = await fetch(SETTING_URL);

    if (resp.ok) {
      const setting = await resp.json();

      if (setting.value) {
        cachedUrl = setting.value;

        return setting.value;
      }
    }
  } catch { /* no setting — fall through */ }

  cachedUrl = defaultApiUrl();

  return cachedUrl;
}

function csrfHeader(): Record<string, string> {
  const match = document.cookie.match(/(?:^|;\s*)CSRF=([^;]*)/);

  return { 'X-Api-Csrf': match ? decodeURIComponent(match[1]) : 'CSRF' };
}

// Persists locally and — best effort — into the Rancher-wide Setting so
// every user/browser of this Rancher gets it automatically.
export async function setApiUrl(url: string): Promise<void> {
  window.localStorage.setItem(STORAGE_KEY, url);
  cachedUrl = url;

  try {
    const resp = await fetch(SETTING_URL);

    if (resp.ok) {
      const setting = await resp.json();

      setting.value = url;
      await fetch(SETTING_URL, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body:    JSON.stringify(setting),
      });
    } else {
      await fetch('/v1/management.cattle.io.settings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...csrfHeader() },
        body:    JSON.stringify({
          type:     'management.cattle.io.setting',
          metadata: { name: 'magic-closet-controller' },
          value:    url,
          default:  '',
        }),
      });
    }
  } catch { /* setting write is optional */ }
}

// A closet's own API/dashboard: same host as the controller, its own port.
// When the controller is reached via its compose-internal name (viewing
// through the rancher-browser), other closets' host ports are only reachable
// via the docker bridge gateway.
export function closetUrl(closet: any, hostGateway?: string): string {
  const controller = new URL(getApiUrl());
  let host = controller.hostname;

  if (host === 'api' && hostGateway) {
    host = hostGateway;
  }

  const secure = controller.protocol === 'https:';
  const port = secure ? (closet.apiHttpsPort || closet.apiPort) : closet.apiPort;

  return `${ secure ? 'https' : 'http' }://${ host }:${ port }`;
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
