<script>
import { RcSection } from '@components/RcSection';
import { RcButton } from '@components/RcButton';
import { BadgeState } from '@components/BadgeState';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import SidecarCard from '../components/SidecarCard';
import { closetApiBase, rancherFetch, setCluster } from '../api';

const GROUP_ORDER = ['dev', 'auth', 'design'];

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
      busy:     {},
      edits:    {},        // sidecar -> { paramId -> value }
      options:  {},        // "sidecar::param" -> option list
      authSel:  '',
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
      if (this.busy[s.name]) {
        return 'bg-info';
      }

      return {
        running: 'bg-success', exited: 'bg-warning', created: 'bg-warning', not_created: 'bg-darker',
      }[s.status] || 'bg-info';
    },

    badgeLabel(s) {
      if (this.busy[s.name]) {
        return this.busy[s.name];
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

      return this.act(s.name, s.status === 'running' ? 'Restarting' : 'Starting', `sidecars/${ s.name }/start`, { params });
    },

    stop(s) {
      return this.act(s.name, 'Stopping', `sidecars/${ s.name }/stop`);
    },

    applyAuth() {
      const sel = this.authProviders.find((p) => p.value === this.authSel);

      return this.act(sel?.sidecar || 'rancher', 'Applying', 'auth/apply', { provider: this.authSel });
    },

    authApplied() {
      return this.authSel === this.rancher.authProvider;
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
            <div class="auth">
              <LabeledSelect
                label="rancher auth"
                :value="authSel"
                :options="authProviders"
                :searchable="false"
                @update:value="authSel = typeof $event === 'object' ? ($event && $event.value) : $event"
              />
              <RcButton
                variant="secondary"
                size="small"
                :disabled="authApplied() || !rancher.running || !!busy[s.name]"
                @click="applyAuth()"
              >
                {{ authApplied() ? 'Applied' : 'Apply' }}
              </RcButton>
            </div>
          </template>

          <template v-if="!(s.unsupported && s.status === 'not_created')" #actions>
            <RcButton
              v-if="['running', 'exited', 'created'].includes(s.status)"
              variant="secondary"
              size="small"
              :disabled="!!busy[s.name] || s.status !== 'running'"
              @click="stop(s)"
            >
              Stop
            </RcButton>
            <RcButton
              variant="primary"
              size="small"
              :disabled="!!busy[s.name]"
              @click="start(s)"
            >
              {{ s.status === 'running' ? 'Restart' : 'Start' }}
            </RcButton>
          </template>
        </SidecarCard>
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

  .auth {
    display: flex;
    align-items: flex-end;
    gap: 8px;

    > :first-child { flex: 1; }
  }
}
</style>
