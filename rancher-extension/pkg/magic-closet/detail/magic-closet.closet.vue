<script>
import { closetApiBase, rancherFetch, setCluster } from '../api';

const GROUP_ORDER = ['dev', 'auth', 'design'];

// Params managed by the secret set — never shown as closet params
const SECRET_SET_KEYS = [
  'ghToken', 'appcoEmail', 'appcoToken', 'awsAccessKey', 'awsSecretKey', 'apiKey',
  'gcpServiceAccountKey', 'azureClientId', 'azureClientSecret', 'azureSubscriptionId', 'azureTenantId',
];

// Interactive closet dashboard — a Vue port of the standalone portal
// (api/src/dashboard.html): one card per sidecar with a status dot, launch
// links, a Configuration accordion, and Start/Stop/Restart actions.
export default {
  name: 'ClosetDetail',

  props: {
    value: {
      type:     Object,
      required: true,
    },
  },

  data() {
    return {
      sidecars:     [],
      rancher:      { running: false, authProvider: null },
      error:        null,
      timer:        null,
      // name -> label while an action is in flight
      busy:         {},
      // sidecar -> { paramId -> input value }
      edits:        {},
      // "sidecar::param" -> suggestion options
      options:      {},
      // which accordions are open (preserved across refreshes)
      openSections: {},
      authSel:      '',
    };
  },

  computed: {
    apiBase() {
      setCluster(this.$route.params.cluster);

      return closetApiBase(this.value.spec.namespace);
    },

    groups() {
      const byGroup = {};

      for (const s of this.sidecars) {
        (byGroup[s.group || 'dev'] = byGroup[s.group || 'dev'] || []).push(s);
      }

      return Object.keys(byGroup)
        .sort((a, b) => (GROUP_ORDER.indexOf(a) < 0 ? 99 : GROUP_ORDER.indexOf(a)) - (GROUP_ORDER.indexOf(b) < 0 ? 99 : GROUP_ORDER.indexOf(b)))
        .map((name) => ({ name, sidecars: byGroup[name] }));
    },

    // Every rancher-auth provider across the auth sidecars, for the rancher card
    authProviders() {
      const out = [];

      for (const sc of this.sidecars) {
        for (const m of sc.rancherAuth?.modes || []) {
          out.push({ value: m.value, label: m.label, sidecar: sc.name, available: sc.status === 'running' });
        }
      }

      return out;
    },
  },

  created() {
    this.refresh();
    this.timer = setInterval(() => {
      if (!Object.keys(this.busy).length) {
        this.refresh();
      }
    }, 4000);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    async refresh() {
      try {
        const data = await rancherFetch(`${ this.apiBase }/sidecars`);

        this.sidecars = data.sidecars || [];
        this.rancher = data.rancher || { running: false, authProvider: null };
        // seed edit values for any param we're not already editing
        for (const s of this.sidecars) {
          const cur = this.edits[s.name] || {};

          for (const p of s.params || []) {
            if (cur[p.id] === undefined) {
              cur[p.id] = p.value ?? '';
            }
            if (p.options && !this.options[`${ s.name }::${ p.id }`]) {
              this.loadOptions(s.name, p.id);
            }
          }
          this.edits[s.name] = cur;
        }
        if (!this.authSel) {
          const first = this.authProviders.find((p) => p.value === this.rancher.authProvider) || this.authProviders.find((p) => p.available);

          this.authSel = first ? first.value : '';
        }
        this.error = null;
      } catch (e) {
        this.error = e.message;
      }
    },

    async loadOptions(sidecar, paramId) {
      const key = `${ sidecar }::${ paramId }`;

      this.options[key] = this.options[key] || [];
      try {
        const r = await rancherFetch(`${ this.apiBase }/sidecars/${ sidecar }/params/${ paramId }/options`);

        this.options[key] = (r.options || []).map((o) => (typeof o === 'object' ? o : { label: o, value: o }));
      } catch { /* best-effort */ }
    },

    // ---- status ----
    statusInfo(s) {
      if (this.busy[s.name]) {
        return { cls: 'busy', label: this.busy[s.name] };
      }
      if (s.status === 'running') {
        return { cls: 'running', label: s.health && s.health !== 'healthy' ? `running (${ s.health })` : 'running' };
      }
      if (s.status === 'not_created') {
        return { cls: '', label: 'not created' };
      }

      return { cls: 'stopped', label: (s.status || '').replace(/_/g, ' ') };
    },

    // ---- links ----
    // rancher-browser is only reachable via the Rancher service proxy here (its
    // NodePort resolves to the node's private IP), so always use the proxy for it
    // and never surface the external URL.
    preferExternal(s) {
      if (s.name === 'rancher-browser') {
        return false;
      }

      return s.external && (!s.proxy || s.proxy.prefer === 'external');
    },

    proxyUrl(s) {
      if (!s.proxy) {
        return null;
      }

      return this.apiBase.replace(/http:api:8080\/proxy$/, `${ s.proxy.scheme }:${ s.name }:${ s.proxy.port }/proxy/`);
    },

    // The external NodePort URL uses the k8s node's IP, which in most clusters
    // is a private address the user's browser can't reach — hide it there.
    reachable(url) {
      const h = (url || '').match(/^https?:\/\/([^:/]+)/)?.[1];

      if (!h) {
        return false;
      }

      return !(/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^127\./.test(h));
    },

    launchLink(s) {
      if (s.status !== 'running') {
        return null;
      }
      if (this.preferExternal(s)) {
        // A private-IP NodePort isn't reachable from the browser — drop it;
        // those sidecars are opened via Internal Launch (the rancher-browser).
        return this.reachable(s.external) ? s.external : null;
      }

      return this.proxyUrl(s);
    },

    browserSidecar() {
      return this.sidecars.find((x) => x.name === 'rancher-browser');
    },

    canInternalLaunch(s) {
      const b = this.browserSidecar();

      return !!(s.internal && s.status === 'running' && s.name !== 'rancher-browser' && b && b.status === 'running');
    },

    async internalLaunch(s) {
      try {
        await rancherFetch(`${ this.apiBase }/browser/open`, { method: 'POST', body: JSON.stringify({ url: s.internal }) });
        const link = this.launchLink(this.browserSidecar());

        if (link) {
          window.open(link, '_blank', 'noopener');
        }
      } catch (e) {
        this.error = `browser: ${ e.message }`;
      }
    },

    // ---- config ----
    flatParams(s) {
      return (s.params || []).filter((p) => !p.group && !SECRET_SET_KEYS.includes(p.id));
    },

    paramGroups(s) {
      const names = [...new Set((s.params || []).filter((p) => p.group && !SECRET_SET_KEYS.includes(p.id)).map((p) => p.group))];

      return names.map((g) => ({ name: g, params: (s.params || []).filter((p) => p.group === g && !SECRET_SET_KEYS.includes(p.id)) }));
    },

    hasConfig(s) {
      return this.flatParams(s).length || this.paramGroups(s).length || s.name === 'rancher';
    },

    toggleSection(key) {
      this.openSections[key] = !this.openSections[key];
    },

    // ---- actions ----
    async act(name, label, path, body) {
      this.busy = { ...this.busy, [name]: label };
      try {
        await rancherFetch(`${ this.apiBase }/${ path }`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        this.error = `${ label } ${ name }: ${ e.message }`;
      } finally {
        const b = { ...this.busy };

        delete b[name];
        this.busy = b;
        this.refresh();
      }
    },

    start(s) {
      const params = {};

      for (const p of s.params || []) {
        const v = this.edits[s.name]?.[p.id];

        params[p.id] = p.type === 'boolean' ? (v && v !== 'false' ? 'true' : '') : (v ?? '');
      }

      return this.act(s.name, s.status === 'running' ? 'restarting' : 'starting', `sidecars/${ s.name }/start`, { params });
    },

    stop(s) {
      return this.act(s.name, 'stopping', `sidecars/${ s.name }/stop`);
    },

    applyAuth() {
      const sel = this.authProviders.find((p) => p.value === this.authSel);

      return this.act(sel ? sel.sidecar : 'rancher', 'applying', 'auth/apply', { provider: this.authSel });
    },

    authApplied() {
      return this.authSel && this.authSel === this.rancher.authProvider;
    },
  },
};
</script>

<template>
  <div class="mc-portal">
    <div v-if="error" class="mc-banner">
      {{ error }}
    </div>

    <div class="mc-grid">
      <template v-for="group in groups" :key="group.name">
        <div class="mc-group-title">
          {{ group.name }}
        </div>

        <div
          v-for="s in group.sidecars"
          :key="s.name"
          class="mc-card"
        >
          <div class="mc-card-head">
            <span
              :class="['mc-dot', statusInfo(s).cls]"
              :title="statusInfo(s).label"
            />
            <span class="mc-name">{{ s.name }}</span>
          </div>

          <div v-if="s.description" class="mc-desc">
            {{ s.description }}
          </div>

          <!-- Configuration accordion -->
          <details
            v-if="hasConfig(s)"
            class="mc-accordion"
            :open="!!openSections[`${s.name}/cfg`]"
            @toggle="openSections[`${s.name}/cfg`] = $event.target.open"
          >
            <summary>Configuration</summary>
            <div class="mc-acc-body">
              <div v-for="p in flatParams(s)" :key="p.id" class="mc-param">
                <label :title="p.description || p.id">{{ p.id }}</label>
                <input
                  v-if="p.type === 'boolean'"
                  type="checkbox"
                  :checked="edits[s.name][p.id] === 'true'"
                  @change="edits[s.name][p.id] = $event.target.checked ? 'true' : ''"
                >
                <input
                  v-else
                  v-model="edits[s.name][p.id]"
                  :list="p.options ? `opt-${s.name}-${p.id}` : null"
                  :placeholder="p.default || ''"
                >
                <datalist v-if="p.options" :id="`opt-${s.name}-${p.id}`">
                  <option v-for="o in options[`${s.name}::${p.id}`] || []" :key="o.value" :value="o.value" />
                </datalist>
              </div>

              <details
                v-for="pg in paramGroups(s)"
                :key="pg.name"
                class="mc-accordion"
                :open="!!openSections[`${s.name}/${pg.name}`]"
                @toggle="openSections[`${s.name}/${pg.name}`] = $event.target.open"
              >
                <summary>{{ pg.name }}</summary>
                <div class="mc-acc-body">
                  <div v-for="p in pg.params" :key="p.id" class="mc-param">
                    <label :title="p.description || p.id">{{ p.id }}</label>
                    <input v-model="edits[s.name][p.id]" :placeholder="p.default || ''">
                  </div>
                </div>
              </details>

              <!-- Auth provider selector on the rancher card -->
              <div v-if="s.name === 'rancher' && authProviders.length" class="mc-auth">
                <label>Auth Provider</label>
                <div class="mc-auth-controls">
                  <select v-model="authSel">
                    <option
                      v-for="p in authProviders"
                      :key="p.value"
                      :value="p.value"
                      :disabled="!p.available"
                    >
                      {{ p.available ? p.label : `${p.label} (not running)` }}
                    </option>
                  </select>
                  <button
                    class="mc-btn mc-btn-secondary"
                    :disabled="authApplied() || !rancher.running || !!busy[s.name]"
                    @click="applyAuth()"
                  >
                    {{ authApplied() ? 'Applied' : 'Apply' }}
                  </button>
                </div>
              </div>
            </div>
          </details>

          <div v-if="s.unsupported" class="mc-desc mc-italic">
            {{ s.unsupported }}
          </div>

          <!-- Launch links -->
          <div v-if="launchLink(s) || canInternalLaunch(s)" class="mc-links">
            <a
              v-if="launchLink(s)"
              :href="launchLink(s)"
              target="_blank"
              rel="noopener"
              class="mc-link"
            >Launch</a>
            <a
              v-if="canInternalLaunch(s)"
              href="#"
              class="mc-link"
              @click.prevent="internalLaunch(s)"
            >Internal Launch</a>
          </div>

          <!-- Actions -->
          <div v-if="!(s.unsupported && s.status === 'not_created')" class="mc-actions">
            <button
              v-if="['running', 'exited', 'created'].includes(s.status)"
              class="mc-btn mc-btn-stop"
              :disabled="!!busy[s.name] || s.status !== 'running'"
              @click="stop(s)"
            >Stop</button>
            <button
              class="mc-btn mc-btn-start"
              :disabled="!!busy[s.name]"
              @click="start(s)"
            >{{ s.status === 'running' ? 'Restart' : 'Start' }}</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style lang="scss">
/* Hide the Rancher metadata block above the closet dashboard (scoped styles
   can't reach it). The :has() guard limits this to closet detail pages. */
main:has(.mc-portal) .metadata-section,
.dashboard-root:has(.mc-portal) .metadata-section {
  display: none;
}
</style>

<style lang="scss" scoped>
/* Portal design tokens (from api/src/dashboard.html), scoped to the dashboard */
.mc-portal {
  --mc-bg-secondary: #251e24;
  --mc-bg-tertiary: #2d252c;
  --mc-bg-element: #3a2e38;
  --mc-bg-element-hover: #4a3e48;
  --mc-bg-input: #1a1418;
  --mc-text: #ece4e8;
  --mc-text-bright: #fff;
  --mc-text-muted: #a08898;
  --mc-border: #4a3e48;
  --mc-border-dark: #1a1216;
  --mc-status-default: #6a5868;
  --mc-status-running: #5ba8a0;
  --mc-status-stopped: #e88060;
  --mc-accent: #b068a0;
  --mc-accent-hover: #c880b8;
  --mc-error: #e85858;

  padding: 10px 0 40px;

  .mc-banner {
    background: rgba(232, 88, 88, 0.15);
    color: var(--mc-error);
    border-radius: 4px;
    padding: 8px 12px;
    margin-bottom: 12px;
  }

  .mc-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }

  .mc-group-title {
    grid-column: 1 / -1;
    font-size: 13px;
    font-weight: 600;
    color: var(--mc-text-muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    border-bottom: 1px solid var(--mc-border);
    padding-bottom: 4px;
    margin-top: 8px;
  }

  .mc-card {
    background: var(--mc-bg-secondary);
    border: 1px solid var(--mc-border);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .mc-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .mc-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--mc-status-default);
    flex-shrink: 0;

    &.running { background: var(--mc-status-running); }
    &.stopped { background: var(--mc-status-stopped); }
    &.busy {
      background: var(--mc-accent);
      animation: mc-pulse 1s ease-in-out infinite;
    }
  }
  @keyframes mc-pulse { 50% { opacity: 0.3; } }

  .mc-name {
    font-size: 16px;
    font-weight: 600;
    color: var(--mc-text-bright);
    flex: 1;
  }

  .mc-desc {
    font-size: 13px;
    color: var(--mc-text-muted);
    line-height: 1.4;

    &.mc-italic { font-style: italic; }
  }

  .mc-links {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
  }

  .mc-link {
    font-size: 13px;
    color: var(--mc-status-running);
    text-decoration: none;
    cursor: pointer;

    &:hover { text-decoration: underline; }
  }

  .mc-accordion {
    border: 1px solid var(--mc-border);
    border-radius: 4px;
    overflow: hidden;

    summary {
      padding: 4px 8px;
      font-size: 13px;
      color: var(--mc-text-muted);
      cursor: pointer;
      user-select: none;

      &:hover { color: var(--mc-text); background: var(--mc-bg-tertiary); }
    }

    &[open] > summary {
      color: var(--mc-text);
      border-bottom: 1px solid var(--mc-border-dark);
    }
  }

  .mc-acc-body {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .mc-param {
    display: flex;
    flex-direction: column;
    gap: 4px;

    label {
      font-size: 12px;
      color: var(--mc-text-muted);
      text-transform: capitalize;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    input {
      width: 100%;
      box-sizing: border-box;
      background: var(--mc-bg-input);
      border: 1px solid var(--mc-border);
      border-radius: 4px;
      color: var(--mc-text);
      font-size: 13px;
      padding: 4px 8px;

      &:focus { outline: none; border-color: var(--mc-accent); }
    }

    input[type="checkbox"] {
      appearance: none;
      align-self: start;
      width: 34px;
      height: 18px;
      border-radius: 9px;
      background: var(--mc-bg-element);
      position: relative;
      cursor: pointer;
      padding: 0;

      &::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--mc-text-muted);
        transition: left 0.15s;
      }

      &:checked {
        background: var(--mc-accent);
        border-color: var(--mc-accent);
        &::after { left: 18px; background: var(--mc-text-bright); }
      }
    }
  }

  .mc-auth {
    display: flex;
    flex-direction: column;
    gap: 4px;

    label { font-size: 12px; color: var(--mc-text-muted); }

    .mc-auth-controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    select {
      flex: 1;
      min-width: 0;
      background: var(--mc-bg-input);
      border: 1px solid var(--mc-border);
      border-radius: 4px;
      color: var(--mc-text);
      font-size: 13px;
      padding: 4px 8px;
    }
  }

  .mc-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .mc-btn {
    font-size: 13px;
    border: none;
    border-radius: 4px;
    padding: 4px 12px;
    cursor: pointer;

    &:disabled { opacity: 0.5; cursor: default; }
  }

  .mc-btn-start {
    background: var(--mc-accent);
    color: var(--mc-text-bright);
    &:hover:not(:disabled) { background: var(--mc-accent-hover); }
  }

  .mc-btn-stop, .mc-btn-secondary {
    background: var(--mc-bg-element);
    color: var(--mc-text);
    &:hover:not(:disabled) { background: var(--mc-bg-element-hover); color: var(--mc-text-bright); }
  }
}
</style>
