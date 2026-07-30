<script>
import { RcItemCard } from '@components/RcItemCard';
import { RcSection } from '@components/RcSection';
import { BadgeState } from '@components/BadgeState';
import { Checkbox } from '@components/Form/Checkbox';
import { LabeledInput } from '@components/Form/LabeledInput';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { closetApiBase, rancherFetch, setCluster } from '../api';

const GROUP_ORDER = ['dev', 'auth', 'design'];

// Params managed by the secret set — never shown as closet params
const SECRET_SET_KEYS = [
  'ghToken', 'appcoEmail', 'appcoToken', 'awsAccessKey', 'awsSecretKey', 'apiKey',
  'gcpServiceAccountKey', 'azureClientId', 'azureClientSecret', 'azureSubscriptionId', 'azureTenantId',
];

// Interactive closet dashboard: one card per sidecar (status, description,
// launch links, editable Configuration, Start/Stop/Restart) — the same job the
// standalone portal does, built from the shell's card/section/form components.
export default {
  name: 'ClosetDetail',

  components: {
    RcItemCard, RcSection, BadgeState, Checkbox, LabeledInput, LabeledSelect,
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
      busy:     {},        // name -> label while an action runs
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
    // rancher-browser is only reachable via the Rancher service proxy here (its
    // NodePort resolves to the node's private IP) — always proxy it.
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

    proxyUrl(s) {
      return s.proxy ? this.apiBase.replace(/http:api:8080\/proxy$/, `${ s.proxy.scheme }:${ s.name }:${ s.proxy.port }/proxy/`) : null;
    },

    launchLink(s) {
      if (s.status !== 'running') {
        return null;
      }
      if (this.preferExternal(s)) {
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
        <rc-item-card
          v-for="s in group.sidecars"
          :id="`sidecar-${s.name}`"
          :key="s.name"
          :header="{}"
          variant="medium"
        >
          <template #item-card-header-title>
            <div class="title-row">
              <h3 class="item-card-header-title medium">
                {{ s.name }}
              </h3>
              <BadgeState
                :color="badgeColor(s)"
                :label="badgeLabel(s)"
                :title="badgeTitle(s)"
                class="status-badge"
              />
            </div>
          </template>

          <template #item-card-sub-header>
            <div class="sub">
              <div v-if="s.description" class="desc">
                {{ s.description }}
              </div>
              <div class="links">
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
              </div>
              <span v-if="s.unsupported" class="unsupported">{{ s.unsupported }}</span>
            </div>
          </template>

          <template #item-card-footer>
            <div class="footer">
              <details v-if="hasConfig(s)" class="config">
                <summary>Configuration</summary>
                <div class="config-body">
                  <template v-for="p in flatParams(s)" :key="p.id">
                    <Checkbox
                      v-if="p.type === 'boolean'"
                      :value="edits[s.name][p.id] === 'true'"
                      :label="p.id"
                      @update:value="edits[s.name][p.id] = $event ? 'true' : ''"
                    />
                    <LabeledSelect
                      v-else-if="p.options"
                      :label="p.id"
                      :value="edits[s.name][p.id]"
                      :options="options[`${s.name}::${p.id}`] || []"
                      :taggable="true"
                      :searchable="true"
                      @update:value="edits[s.name][p.id] = typeof $event === 'object' ? ($event && $event.value) : $event"
                    />
                    <LabeledInput
                      v-else
                      v-model:value="edits[s.name][p.id]"
                      :label="p.id"
                      :placeholder="p.default || ''"
                    />
                  </template>

                  <template v-for="pg in paramGroups(s)" :key="pg.name">
                    <LabeledInput
                      v-for="p in pg.params"
                      :key="p.id"
                      v-model:value="edits[s.name][p.id]"
                      :label="`${pg.name} · ${p.id}`"
                      :placeholder="p.default || ''"
                    />
                  </template>

                  <div v-if="s.name === 'rancher' && authProviders.length > 1" class="auth">
                    <LabeledSelect
                      label="rancher auth"
                      :value="authSel"
                      :options="authProviders"
                      :searchable="false"
                      @update:value="authSel = typeof $event === 'object' ? ($event && $event.value) : $event"
                    />
                    <button
                      class="btn role-secondary btn-sm"
                      :disabled="authApplied() || !rancher.running || !!busy[s.name]"
                      @click="applyAuth()"
                    >
                      {{ authApplied() ? 'Applied' : 'Apply' }}
                    </button>
                  </div>
                </div>
              </details>

              <div v-if="!(s.unsupported && s.status === 'not_created')" class="actions">
                <button
                  v-if="['running', 'exited', 'created'].includes(s.status)"
                  class="btn role-secondary btn-sm"
                  :disabled="!!busy[s.name] || s.status !== 'running'"
                  @click="stop(s)"
                >
                  Stop
                </button>
                <button
                  class="btn role-primary btn-sm"
                  :disabled="!!busy[s.name]"
                  @click="start(s)"
                >
                  {{ s.status === 'running' ? 'Restart' : 'Start' }}
                </button>
              </div>
            </div>
          </template>
        </rc-item-card>
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

  .title-row {
    display: flex;
    align-items: center;

    h3 { margin: 0; }
  }

  .status-badge { margin-left: 8px; }

  .sub {
    display: flex;
    flex-direction: column;
    gap: 6px;

    .desc { color: var(--input-label, var(--muted)); font-size: 13px; }

    .links {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;

      a { cursor: pointer; }
    }
  }

  .unsupported { font-style: italic; color: var(--muted); font-size: 12px; }

  .footer {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
  }

  .config {
    border: 1px solid var(--border);
    border-radius: var(--border-radius, 4px);

    summary {
      padding: 4px 8px;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
    }

    &[open] > summary {
      color: var(--body-text);
      border-bottom: 1px solid var(--border);
    }

    .config-body {
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .auth {
      display: flex;
      align-items: flex-end;
      gap: 8px;

      > :first-child { flex: 1; }
    }
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .btn-sm { padding: 4px 12px; min-height: unset; line-height: 1.4; }
}
</style>
