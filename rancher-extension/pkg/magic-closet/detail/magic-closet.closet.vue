<script>
import { RcItemCard } from '@components/RcItemCard';
import { BadgeState } from '@components/BadgeState';
import { closetApiBase, rancherFetch, setCluster } from '../api';

const GROUP_ORDER = ['dev', 'auth', 'design'];

// Read-only view of the closet: current sidecar state, links and configured
// params. Changing anything happens through Edit Config.
export default {
  name: 'ClosetDetail',

  components: { RcItemCard, BadgeState },

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
      } catch (e) {
        this.error = e.message;
      }
    },

    cardFor(s) {
      return {
        id:     `sidecar-${ s.name }`,
        header: {},
      };
    },

    badgeColor(s) {
      const map = {
        running: 'bg-success', exited: 'bg-warning', created: 'bg-warning', not_created: 'bg-darker',
      };

      return map[s.status] || 'bg-info';
    },

    statusLabel(s) {
      const t = (s.status || '').replace(/_/g, ' ');

      return t.charAt(0).toUpperCase() + t.slice(1);
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

    shownParams(s) {
      return (s.params || []).filter((p) => p.value !== undefined && p.value !== null && p.value !== '');
    },

    authFor(s) {
      if (!s.rancherAuth) {
        return null;
      }
      const active = (s.rancherAuth.modes || []).find((m) => m.value === this.rancher.authProvider);

      return active ? `applied (${ active.label })` : 'not applied';
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
          <template #item-card-header-title>
            <h3 class="item-card-header-title medium">
              {{ s.name }}
            </h3>
            <BadgeState
              :color="badgeColor(s)"
              :label="statusLabel(s)"
              :title="badgeTitle(s)"
              class="status-badge"
            />
          </template>

          <template #item-card-sub-header>
            <div class="sub">
              <div class="desc">
                {{ s.description }}
              </div>
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
            </div>
          </template>

          <template #item-card-footer>
            <div class="card-extras">
              <div v-for="p in shownParams(s)" :key="p.id" class="param-row">
                <label>{{ p.id }}</label>
                <span class="param-value">{{ p.value }}</span>
              </div>
              <div v-if="s.rancherAuth" class="param-row">
                <label>rancher auth</label>
                <span class="param-value">{{ authFor(s) }}</span>
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

  .status-badge {
    margin-left: 8px;
  }

  .sub {
    display: flex;
    flex-direction: column;
    gap: 4px;

    .desc {
      color: var(--body-text);
    }
  }

  .unsupported {
    font-style: italic;
    color: var(--muted);
    font-size: 12px;
  }

  .card-extras {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;

    .param-row {
      display: flex;
      align-items: baseline;
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

      .param-value {
        font-size: 13px;
        overflow-wrap: anywhere;
      }
    }
  }
}
</style>
