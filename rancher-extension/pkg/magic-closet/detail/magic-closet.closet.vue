<script>
import { RcSection } from '@components/RcSection';
import { RcButton } from '@components/RcButton';
import { BadgeState } from '@components/BadgeState';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import SidecarCard from '../components/SidecarCard';
import { closetApiBase, rancherFetch, setCluster } from '../api';

const GROUP_ORDER = ['dev', 'auth', 'design'];

// Sidecars no longer offered — hidden from the closet dashboard.
const HIDDEN_SIDECARS = ['vscode'];

// Params never shown as closet config: secret-set-managed credentials + the
// GitHub URL.
const HIDDEN_PARAMS = [
  'ghToken', 'appcoEmail', 'appcoToken', 'awsAccessKey', 'awsSecretKey', 'apiKey',
  'gcpServiceAccountKey', 'azureClientId', 'azureClientSecret', 'azureSubscriptionId', 'azureTenantId',
  'githubUrl',
];

// Interactive closet dashboard: one SidecarCard per sidecar (status, launch
// links, editable Configuration, Start/Stop/Restart).
export default {
  name: 'ClosetDetail',

  components: {
    RcSection, RcButton, BadgeState, LabeledSelect, SidecarCard,
  },

  props: {
    value: {
      type:     Object,
      required: true,
    },
  },

  data() {
    return {
      sidecars: [],
      rancher:  { running: false, authProvider: null },
      error:    null,
      timer:    null,
      // Optimistic overlay: name -> { label, goal: 'running'|'stopped', since }.
      // Set the instant the user clicks, cleared once the polled status reaches
      // the goal (or after a timeout) — so the card reacts immediately instead
      // of snapping states after the request round-trips.
      pending:  {},
      applying: false,     // rancher auth "Apply" in flight
      edits:    {},        // sidecar -> { paramId -> value }
      options:  {},        // "sidecar::param" -> option list
      authSel:  '',
      configFor: null,     // name of the sidecar whose config modal is open
      copied:    false,    // "Connect VS Code" command copied feedback
      tunnel:    { state: 'off' }, // VS Code tunnel status (from the closet api)
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

    authProviders() {
      const out = [{ value: '', label: 'None' }];

      for (const sc of this.sidecars) {
        for (const m of sc.rancherAuth?.modes || []) {
          out.push({ value: m.value, label: `${ sc.name }: ${ m.label }`, sidecar: sc.name, disabled: sc.status !== 'running' });
        }
      }

      return out;
    },

    // A single shell command the user pastes into a local terminal (with
    // kubectl pointed at this cluster) to wire up VS Code Remote-SSH to the
    // closet's /workspace: it makes a local key, pushes the pubkey into the
    // pod's persistent authorized_keys, and writes an ~/.ssh/config entry whose
    // ProxyCommand bridges to the pod's sshd over `kubectl exec`.
    vscodeCommand() {
      const ns = this.value?.spec?.namespace || '';
      const h = this.value?.metadata?.name || 'closet';

      return [
        `NS=${ ns }`,
        `H=${ h }`,
        'K="$HOME/.ssh/mc-$H"',
        `[ -f "$K" ] || ssh-keygen -t ed25519 -N '' -f "$K" -q`,
        `kubectl -n "$NS" exec -i deploy/closet -- sh -c 'mkdir -p /workspace/.mc-ssh; chmod 700 /workspace/.mc-ssh; touch /workspace/.mc-ssh/authorized_keys; chmod 600 /workspace/.mc-ssh/authorized_keys; grep -qxF "$0" /workspace/.mc-ssh/authorized_keys || echo "$0" >> /workspace/.mc-ssh/authorized_keys' "$(cat "$K.pub")"`,
        'mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/config"',
        `sed -i.bak "/# >>> magic-closet $H >>>/,/# <<< magic-closet $H <<</d" "$HOME/.ssh/config"`,
        `printf '\\n# >>> magic-closet %s >>>\\nHost %s\\n  User root\\n  IdentityFile %s\\n  StrictHostKeyChecking no\\n  UserKnownHostsFile /dev/null\\n  ProxyCommand kubectl exec -i -n %s deploy/closet -- nc -q1 127.0.0.1 2222\\n# <<< magic-closet %s <<<\\n' "$H" "$H" "$K" "$NS" "$H" >> "$HOME/.ssh/config"`,
        `echo "Done — in VS Code: Remote-SSH → Connect to Host → $H"`,
      ].join('; ');
    },
  },

  created() {
    this.refresh();
    // Poll continuously (including during a pending action) so the optimistic
    // overlay clears as soon as the real status catches up.
    this.timer = setInterval(() => this.refresh(), 2500);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    async refresh() {
      try {
        const data = await rancherFetch(`${ this.apiBase }/sidecars`);

        this.sidecars = (data.sidecars || []).filter((s) => !HIDDEN_SIDECARS.includes(s.name));
        this.rancher = data.rancher || { running: false, authProvider: null };
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
          this.authSel = this.rancher.authProvider || '';
        }
        this.reconcilePending();
        this.error = null;
      } catch (e) {
        this.error = e.message;
      }

      // Best-effort: VS Code tunnel status (separate so a missing/old endpoint
      // never breaks the dashboard).
      try {
        this.tunnel = await rancherFetch(`${ this.apiBase }/tunnel`);
      } catch { /* older api without /tunnel */ }
    },

    // Drop an optimistic entry once the real status reaches its goal (held a
    // beat so a restart-of-a-running sidecar still flashes feedback), or after
    // a timeout so a stuck action can't pin the card forever.
    reconcilePending() {
      let changed = false;
      const now = Date.now();

      for (const s of this.sidecars) {
        const p = this.pending[s.name];

        if (!p) {
          continue;
        }
        const reached = p.goal === 'running'
          ? s.status === 'running'
          : ['exited', 'created', 'not_created'].includes(s.status);

        if ((reached && now - p.since > 1200) || now - p.since > 180000) {
          delete this.pending[s.name];
          changed = true;
        }
      }
      if (changed) {
        this.pending = { ...this.pending };
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

    // Map the api's params to the SidecarCard's normalized shape (hidden ones
    // dropped, grouped ones prefixed).
    cardParams(s) {
      const out = [];

      for (const p of s.params || []) {
        if (HIDDEN_PARAMS.includes(p.id)) {
          continue;
        }
        out.push({
          id:          p.id,
          label:       p.group ? `${ p.group } · ${ p.id }` : p.id,
          type:        p.type === 'boolean' ? 'boolean' : (p.options ? 'select' : 'text'),
          options:     p.options ? (this.options[`${ s.name }::${ p.id }`] || []) : undefined,
          taggable:    !!p.options,
          placeholder: p.default || '',
        });
      }

      return out;
    },

    // ---- status badge ----
    badgeColor(s) {
      if (this.pending[s.name]) {
        return 'bg-info';
      }

      return {
        running: 'bg-success', exited: 'bg-warning', created: 'bg-warning', not_created: 'bg-darker',
      }[s.status] || 'bg-info';
    },

    badgeLabel(s) {
      const p = this.pending[s.name];

      if (p) {
        return p.label;
      }
      const t = (s.status || '').replace(/_/g, ' ');

      return t.charAt(0).toUpperCase() + t.slice(1);
    },

    badgeTitle(s) {
      return [s.health, s.bootstrap ? `bootstrap: ${ s.bootstrap }` : null].filter(Boolean).join(' · ');
    },

    // ---- links ----
    // rancher-browser is only reachable via the Rancher service proxy here.
    preferExternal(s) {
      if (s.name === 'rancher-browser') {
        return false;
      }

      return s.external && (!s.proxy || s.proxy.prefer === 'external');
    },

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
        return this.reachable(s.external) ? s.external : null;
      }

      return s.proxy ? this.apiBase.replace(/http:api:8080\/proxy$/, `${ s.proxy.scheme }:${ s.name }:${ s.proxy.port }/proxy/`) : null;
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

    // ---- actions ----
    // Set the optimistic overlay first (instant feedback), fire the request,
    // then refresh. On failure, drop the overlay and surface the error; on
    // success leave it for reconcilePending() to clear when the status lands.
    async act(name, label, goal, path, body) {
      this.pending = { ...this.pending, [name]: { label, goal, since: Date.now() } };
      try {
        await rancherFetch(`${ this.apiBase }/${ path }`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
      } catch (e) {
        this.error = `${ label } ${ name }: ${ e.message }`;
        const p = { ...this.pending };

        delete p[name];
        this.pending = p;

        return;
      }
      this.refresh();
    },

    start(s) {
      const params = {};

      for (const p of s.params || []) {
        const v = this.edits[s.name]?.[p.id];

        params[p.id] = p.type === 'boolean' ? (v && v !== 'false' ? 'true' : '') : (v ?? '');
      }

      return this.act(s.name, s.status === 'running' ? 'Restarting' : 'Starting', 'running', `sidecars/${ s.name }/start`, { params });
    },

    stop(s) {
      return this.act(s.name, 'Stopping', 'stopped', `sidecars/${ s.name }/stop`);
    },

    // Does this sidecar have anything to configure (params or rancher auth)?
    hasConfigFor(s) {
      return this.cardParams(s).length > 0 || (s.name === 'rancher' && this.authProviders.length > 1);
    },

    // Start button: if there's configuration to pick, open the modal first;
    // otherwise start straight away.
    onStart(s) {
      if (this.hasConfigFor(s)) {
        this.configFor = s.name;

        return null;
      }

      return this.start(s);
    },

    // Did a restart-requiring param (e.g. tag, prime) change from its current
    // value?
    restartNeeded(s) {
      return (s.params || []).some((p) => {
        if (HIDDEN_PARAMS.includes(p.id)) {
          return false;
        }
        const cur = String(p.value ?? p.default ?? '');
        const edited = String(this.edits[s.name]?.[p.id] ?? '');

        return edited !== cur;
      });
    },

    // Did the rancher auth selection change from what's currently applied?
    authChanged(s) {
      return s.name === 'rancher' && this.authProviders.length > 1 && this.authSel !== (this.rancher.authProvider || '');
    },

    // The single save button's label reflects the pending change: starting a
    // stopped sidecar, restarting for a param change, or just applying an auth
    // change (no restart).
    saveLabelFor(s) {
      if (s.status !== 'running') {
        return 'Save & Start';
      }
      if (this.restartNeeded(s)) {
        return 'Save & Restart';
      }
      if (this.authChanged(s)) {
        return 'Save & Apply';
      }

      return 'Save & Restart';
    },

    copyVscode() {
      const done = () => {
        this.copied = true;
        setTimeout(() => {
          this.copied = false;
        }, 2000);
      };

      navigator.clipboard?.writeText(this.vscodeCommand).then(done, () => {
        // Fallback for insecure contexts without the async clipboard API
        const ta = document.createElement('textarea');

        ta.value = this.vscodeCommand;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch { /* ignore */ }
        document.body.removeChild(ta);
      });
    },

    // Modal Save: apply auth if it changed (no restart), and (re)start the
    // sidecar unless the only change was an auth apply on a running sidecar.
    onSave(s) {
      const running = s.status === 'running';
      const restart = this.restartNeeded(s);
      const auth = this.authChanged(s);

      this.configFor = null;

      if (auth) {
        this.applyAuth();
      }
      if (!running || restart || !auth) {
        this.start(s);
      }
    },

    async applyAuth() {
      this.applying = true;
      try {
        await rancherFetch(`${ this.apiBase }/auth/apply`, { method: 'POST', body: JSON.stringify({ provider: this.authSel }) });
      } catch (e) {
        this.error = `apply auth: ${ e.message }`;
      } finally {
        this.applying = false;
        this.refresh();
      }
    },
  },
};
</script>

<template>
  <div class="closet-dashboard">
    <div v-if="error" class="banner error">
      {{ error }}
    </div>

    <RcSection
      v-for="group in groups"
      :key="group.name"
      :title="group.name.charAt(0).toUpperCase() + group.name.slice(1)"
      type="primary"
      mode="with-header"
      class="sidecar-group"
    >
      <div class="cards">
        <SidecarCard
          v-for="s in group.sidecars"
          :key="s.name"
          :name="s.name"
          :description="s.description"
          :params="cardParams(s)"
          :values="edits[s.name] || {}"
          :unsupported="s.unsupported || ''"
          :config-open="configFor === s.name"
          :save-label="saveLabelFor(s)"
          @update:config-open="configFor = $event ? s.name : null"
          @save="onSave(s)"
        >
          <template #header-right>
            <BadgeState
              :color="badgeColor(s)"
              :label="badgeLabel(s)"
              :title="badgeTitle(s)"
            />
          </template>

          <template #links>
            <a
              v-if="launchLink(s)"
              :href="launchLink(s)"
              target="_blank"
              rel="noopener"
            >Launch</a>
            <a
              v-if="canInternalLaunch(s)"
              href="#"
              @click.prevent="internalLaunch(s)"
            >Internal Launch</a>
          </template>

          <template v-if="s.name === 'rancher' && authProviders.length > 1" #config-extra>
            <LabeledSelect
              label="rancher auth"
              :value="authSel"
              :options="authProviders"
              :searchable="false"
              :append-to-body="false"
              @update:value="authSel = typeof $event === 'object' ? ($event && $event.value) : $event"
            />
          </template>

          <template v-if="!(s.unsupported && s.status === 'not_created')" #actions>
            <template v-if="s.status === 'running'">
              <RcButton
                variant="secondary"
                :disabled="!!pending[s.name]"
                @click="stop(s)"
              >
                Stop
              </RcButton>
              <RcButton
                variant="primary"
                :disabled="!!pending[s.name]"
                @click="start(s)"
              >
                Restart
              </RcButton>
            </template>
            <RcButton
              v-else
              variant="primary"
              :disabled="!!pending[s.name]"
              @click="onStart(s)"
            >
              Start
            </RcButton>
          </template>
        </SidecarCard>
      </div>
    </RcSection>

    <RcSection
      title="VS Code Remote"
      type="primary"
      mode="with-header"
      class="sidecar-group"
    >
      <div class="vscode-remote">
        <div class="tunnel">
          <template v-if="tunnel.state === 'connected'">
            <p class="hint">
              The VS&nbsp;Code tunnel is up — open this closet's <code>/workspace</code> (no kubectl needed):
            </p>
            <div class="links">
              <a
                :href="tunnel.connectUrl || ('https://vscode.dev/tunnel/' + tunnel.name + '/workspace')"
                target="_blank"
                rel="noopener"
              >Open <code>/workspace</code> in vscode.dev</a>
              <span class="muted">or Desktop VS&nbsp;Code → <b>Remote Tunnels</b> → <code>{{ tunnel.name }}</code>, then open <code>/workspace</code></span>
            </div>
          </template>
          <template v-else-if="tunnel.state === 'auth' && tunnel.deviceCode">
            <p class="hint">One-time sign-in to authorize the tunnel:</p>
            <ol class="steps">
              <li>Open <a href="https://github.com/login/device" target="_blank" rel="noopener">github.com/login/device</a></li>
              <li>Enter code <code class="devcode">{{ tunnel.deviceCode }}</code></li>
            </ol>
            <p class="muted">Then this closet appears in Desktop VS&nbsp;Code under <b>Remote Tunnels</b>.</p>
          </template>
          <template v-else>
            <p class="hint">Starting the VS&nbsp;Code tunnel… (the first boot downloads the CLI — give it a moment and it'll show a sign-in code here).</p>
          </template>
        </div>

        <details class="advanced">
          <summary>Advanced: Remote-SSH (requires kubectl)</summary>
          <p class="hint">
            With <code>kubectl</code> pointed at this cluster (download the KubeConfig from Rancher), paste this locally to add a Remote-SSH host, then VS&nbsp;Code: <b>Remote-SSH → Connect to Host → {{ value.metadata.name }}</b>.
          </p>
          <div class="cmd">
            <code>{{ vscodeCommand }}</code>
            <RcButton
              variant="secondary"
              size="small"
              class="copy"
              @click="copyVscode"
            >
              {{ copied ? 'Copied' : 'Copy' }}
            </RcButton>
          </div>
        </details>
      </div>
    </RcSection>
  </div>
</template>

<style lang="scss">
/* Hide the Rancher metadata block above the closet dashboard (scoped styles
   can't reach it). The :has() guard limits this to closet detail pages. */
main:has(.closet-dashboard) .metadata-section,
.dashboard-root:has(.closet-dashboard) .metadata-section {
  display: none;
}
</style>

<style lang="scss" scoped>
.closet-dashboard {
  padding: 10px 0 40px;

  .banner.error {
    background: var(--error-banner-bg, rgba(239, 82, 79, 0.15));
    color: var(--error);
    border-radius: 4px;
    padding: 8px 12px;
    margin-bottom: 12px;
  }

  .sidecar-group { margin-top: 12px; }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
  }

  .vscode-remote {
    .hint {
      color: var(--input-label, var(--muted));
      font-size: 13px;
      margin: 0 0 8px;

      code { font-size: 12px; }
    }

    .muted { color: var(--muted); font-size: 13px; }

    .tunnel {
      .links {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;

        a { cursor: pointer; }
      }

      .steps {
        margin: 0 0 8px;
        padding-left: 20px;
        font-size: 13px;

        li { margin: 2px 0; }
      }

      .devcode {
        font-size: 16px;
        font-weight: 600;
        letter-spacing: 1px;
        padding: 2px 8px;
        background: var(--input-bg, var(--body-bg));
        border: 1px solid var(--border);
        border-radius: 4px;
        user-select: all;
      }
    }

    .advanced {
      margin-top: 14px;
      border-top: 1px solid var(--border);
      padding-top: 10px;

      summary { cursor: pointer; color: var(--muted); font-size: 13px; user-select: none; }
      &[open] > summary { margin-bottom: 8px; }
    }

    .cmd {
      display: flex;
      align-items: stretch;
      gap: 8px;

      code {
        flex: 1;
        min-width: 0;
        overflow-x: auto;
        white-space: pre;
        padding: 10px 12px;
        background: var(--input-bg, var(--body-bg));
        border: 1px solid var(--border);
        border-radius: var(--border-radius, 4px);
        font-family: monospace;
        font-size: 12px;
        line-height: 1.5;
      }

      .copy { flex: 0 0 auto; align-self: flex-start; }
    }
  }
}
</style>
