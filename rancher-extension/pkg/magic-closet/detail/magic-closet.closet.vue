<script>
import { RcItemCard } from '@components/RcItemCard';
import { RcButton } from '@components/RcButton';
import RcIcon from '@components/RcIcon/RcIcon.vue';
import { BadgeState } from '@components/BadgeState';
import { closetApiBase, rancherFetch, setCluster } from '../api';

const GROUP_ORDER = ['dev', 'auth', 'design'];

export default {
  name: 'ClosetDetail',

  components: { RcItemCard, RcButton, RcIcon, BadgeState },

  props: {
    value: {
      type:     Object,
      required: true,
    },
  },

  data() {
    return {
      sidecars:   [],
      rancher:    { running: false, authProvider: null },
      busy:       {},
      authMode:   {},
      paramEdits: {},
      error:      null,
      timer:      null,
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
        const g = s.group || 'dev';

        (byGroup[g] = byGroup[g] || []).push(s);
      }

      return Object.keys(byGroup)
        .sort((a, b) => {
          const ia = GROUP_ORDER.indexOf(a);
          const ib = GROUP_ORDER.indexOf(b);

          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        })
        .map((name) => ({ name, sidecars: byGroup[name] }));
    },
  },

  created() {
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 5000);
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
        this.error = null;

        // Seed editable param values / auth modes once per sidecar
        for (const s of this.sidecars) {
          if (!this.paramEdits[s.name]) {
            const edits = {};

            for (const p of s.params || []) {
              edits[p.id] = p.value ?? p.default ?? '';
            }
            this.paramEdits[s.name] = edits;
          }
          if (!this.authMode[s.name] && s.rancherAuth?.modes?.length) {
            const active = s.rancherAuth.modes.find((m) => m.value === this.rancher.authProvider);

            this.authMode[s.name] = (active || s.rancherAuth.modes[0]).value;
          }
        }
      } catch (e) {
        this.error = e.message;
      }
    },

    cardFor(s) {
      return {
        id:      `sidecar-${ s.name }`,
        header:  { title: { text: s.name } },
        content: { text: s.description || '' },
      };
    },

    badgeColor(s) {
      if (this.busy[s.name]) {
        return 'bg-info';
      }
      const map = {
        running: 'bg-success', exited: 'bg-warning', created: 'bg-warning', not_created: 'bg-darker',
      };

      return map[s.status] || 'bg-info';
    },

    badgeLabel(s) {
      return this.busy[s.name] || s.status;
    },

    badgeTitle(s) {
      return [s.health, s.bootstrap ? `bootstrap: ${ s.bootstrap }` : null].filter(Boolean).join(' · ');
    },

    preferExternal(s) {
      return s.external && (!s.proxy || s.proxy.prefer === 'external');
    },

    linkFor(s) {
      if (s.status !== 'running') {
        return null;
      }
      if (this.preferExternal(s)) {
        return s.external;
      }
      if (s.proxy) {
        return this.apiBase.replace(/http:api:8080\/proxy$/, `${ s.proxy.scheme }:${ s.name }:${ s.proxy.port }/proxy/`);
      }

      return null;
    },

    async act(s, verb, path, method = 'POST', body = undefined) {
      this.busy[s.name] = verb;
      try {
        await rancherFetch(`${ this.apiBase }/${ path }`, {
          method,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        this.error = `${ s.name }: ${ e.message }`;
      }
      delete this.busy[s.name];
      this.refresh();
    },

    start(s) {
      const params = { ...(this.paramEdits[s.name] || {}) };

      for (const p of s.params || []) {
        if (p.type === 'boolean') {
          params[p.id] = params[p.id] && params[p.id] !== 'false' ? 'true' : '';
        }
      }
      this.act(s, 'starting', `sidecars/${ s.name }/start`, 'POST', { params });
    },

    stop(s) {
      this.act(s, 'stopping', `sidecars/${ s.name }/stop`);
    },

    remove(s) {
      this.act(s, 'deleting', `sidecars/${ s.name }`, 'DELETE');
    },

    applyAuth(s) {
      this.act(s, 'applying', 'auth/apply', 'POST', { provider: this.authMode[s.name] });
    },

    authApplied(s) {
      return this.authMode[s.name] === this.rancher.authProvider;
    },

    canApplyAuth(s) {
      return this.rancher.running && s.status === 'running' && !this.authApplied(s) && !this.busy[s.name];
    },
  },
};
</script>

<template>
  <div class="closet-dashboard">
    <div v-if="error" class="banner error">
      {{ error }}
    </div>

    <div v-for="group in groups" :key="group.name" class="sidecar-group">
      <h3 class="group-title">
        {{ group.name }}
      </h3>
      <div class="cards">
        <rc-item-card
          v-for="s in group.sidecars"
          :id="`sidecar-${s.name}`"
          :key="s.name"
          v-bind="cardFor(s)"
          variant="medium"
        >
          <template #item-card-sub-header>
            <BadgeState
              :color="badgeColor(s)"
              :label="badgeLabel(s)"
              :title="badgeTitle(s)"
            />
            <a
              v-if="linkFor(s)"
              :href="linkFor(s)"
              target="_blank"
              rel="noopener"
              item-card-action
            >
              {{ preferExternal(s) ? s.external : `open ${s.name}` }}
            </a>
            <span v-if="s.unsupported" class="unsupported">{{ s.unsupported }}</span>
          </template>

          <template #item-card-footer>
            <div class="card-extras" item-card-action>
              <div v-for="p in s.params || []" :key="p.id" class="param-row">
                <label :for="`${s.name}-${p.id}`">{{ p.id }}</label>
                <input
                  v-if="p.type === 'boolean'"
                  :id="`${s.name}-${p.id}`"
                  type="checkbox"
                  :checked="!!paramEdits[s.name][p.id] && paramEdits[s.name][p.id] !== 'false'"
                  @change="paramEdits[s.name][p.id] = $event.target.checked ? 'true' : ''"
                >
                <input
                  v-else
                  :id="`${s.name}-${p.id}`"
                  v-model="paramEdits[s.name][p.id]"
                  type="text"
                  :placeholder="p.default || ''"
                >
              </div>

              <div v-if="s.rancherAuth" class="param-row auth-row">
                <label>rancher auth</label>
                <select v-if="(s.rancherAuth.modes || []).length > 1" v-model="authMode[s.name]">
                  <option v-for="m in s.rancherAuth.modes" :key="m.value" :value="m.value">
                    {{ m.label }}
                  </option>
                </select>
                <rc-button
                  size="small"
                  variant="secondary"
                  :disabled="!canApplyAuth(s)"
                  @click="applyAuth(s)"
                >
                  {{ authApplied(s) ? 'Applied' : 'Apply' }}
                </rc-button>
              </div>

              <div v-if="!(s.unsupported && s.status === 'not_created')" class="actions">
                <rc-button
                  size="small"
                  variant="primary"
                  :disabled="!!busy[s.name]"
                  @click="start(s)"
                >
                  {{ s.status === 'running' ? 'Restart' : 'Start' }}
                </rc-button>
                <rc-button
                  size="small"
                  variant="secondary"
                  :disabled="!!busy[s.name] || s.status !== 'running'"
                  @click="stop(s)"
                >
                  Stop
                </rc-button>
                <rc-button
                  size="small"
                  variant="ghost"
                  aria-label="Delete"
                  :disabled="!!busy[s.name] || s.status === 'not_created'"
                  @click="remove(s)"
                >
                  <rc-icon type="trash" status="error" />
                </rc-button>
              </div>
            </div>
          </template>
        </rc-item-card>
      </div>
    </div>
  </div>
</template>

<style lang="scss">
/* Global on purpose (scoped styles can't reach the masthead rendered above
   this component): the :has() guard limits it to closet detail pages */
main:has(.closet-dashboard) .metadata-section,
.dashboard-root:has(.closet-dashboard) .metadata-section {
  display: none;
}
</style>

<style lang="scss" scoped>
.closet-dashboard {
  padding: 10px 0 40px 0;

  .banner.error {
    background: var(--error-banner-bg, rgba(239, 82, 79, 0.15));
    color: var(--error);
    border-radius: 4px;
    padding: 8px 12px;
    margin-bottom: 12px;
  }

  .group-title {
    text-transform: uppercase;
    letter-spacing: 1px;
    font-size: 13px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    padding-bottom: 4px;
    margin: 20px 0 12px 0;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
  }

  .unsupported {
    font-style: italic;
    color: var(--muted);
    font-size: 12px;
  }

  .card-extras {
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 100%;

    .param-row {
      display: flex;
      align-items: center;
      gap: 8px;

      label {
        width: 40%;
        margin: 0;
        color: var(--muted);
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      input[type='text'], select {
        flex: 1;
        min-width: 0;
        background: var(--input-bg);
        color: var(--input-text);
        border: 1px solid var(--input-border);
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 13px;
      }
    }

    .actions {
      display: flex;
      gap: 8px;
      margin-top: 4px;
    }
  }
}
</style>
