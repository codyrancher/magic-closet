<script>
import { apiFetch, closetUrl, getApiUrl, resolveApiUrl, setApiUrl } from '../api';

export default {
  name: 'ClosetList',

  data() {
    return {
      closets: [],
      status:  {},
      gateway: null,
      error:   null,
      apiUrl:  getApiUrl(),
      adding:  false,
      newName: '',
      busy:    false,
    };
  },

  async created() {
    await resolveApiUrl();
    this.apiUrl = getApiUrl();
    this.load();
    this.timer = setInterval(this.load, 8000);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    async load() {
      try {
        const data = await apiFetch('/closets');

        this.closets = data.closets || [];
        this.gateway = data.hostGateway || null;
        this.error = null;
        this.probe();
      } catch (e) {
        this.error = `Cannot reach the magic-closet controller at ${ getApiUrl() }: ${ e.message }`;
      }
    },

    // Each provisioned closet runs its own api — ask it for live status
    async probe() {
      for (const c of this.closets) {
        if (c.local || !c.apiPort || c.op) {
          continue;
        }
        try {
          const resp = await fetch(`${ closetUrl(c, this.gateway) }/sidecars`);
          const data = await resp.json();
          const list = data.sidecars || [];

          this.status[c.name] = {
            running:      list.filter((s) => s.status === 'running').length,
            total:        list.length,
            authProvider: data.rancher?.authProvider,
          };
        } catch {
          this.status[c.name] = null;
        }
      }
    },

    async saveApiUrl() {
      await setApiUrl(this.apiUrl);
      this.load();
    },

    sidecarText(c) {
      const s = c.local ? c.sidecars : this.status[c.name];

      if (c.op) {
        return c.op === 'provisioning' ? 'provisioning…' : 'deleting…';
      }

      return s ? `${ s.running }/${ s.total } running` : '—';
    },

    authText(c) {
      return c.local ? c.authProvider : (this.status[c.name]?.authProvider || '—');
    },

    open(closet) {
      if (closet.op) {
        return;
      }
      this.$router.push({
        name:   `c-cluster-magicCloset-closet`,
        params: { cluster: this.$route.params.cluster, closet: closet.name },
      });
    },

    async add() {
      this.busy = true;
      try {
        await apiFetch('/closets', { method: 'POST', body: JSON.stringify({ name: this.newName }) });
        this.adding = false;
        this.newName = '';
        this.load();
      } catch (e) {
        this.error = e.message;
      }
      this.busy = false;
    },

    async remove(closet) {
      try {
        await apiFetch(`/closets/${ encodeURIComponent(closet.name) }`, { method: 'DELETE' });
        this.load();
      } catch (e) {
        this.error = e.message;
      }
    },
  },
};
</script>

<template>
  <div class="closet-list">
    <header class="header">
      <h1>Magic Closet</h1>
      <button class="btn role-primary" @click="adding = !adding">
        Create Closet
      </button>
    </header>

    <div v-if="error" class="banner error">
      {{ error }}
      <div class="api-url">
        <label>Controller API URL</label>
        <input v-model="apiUrl" />
        <button class="btn role-secondary btn-sm" @click="saveApiUrl">Save</button>
      </div>
    </div>

    <div v-if="adding" class="add-form">
      <input v-model="newName" placeholder="closet name (e.g. pr-18387)" />
      <button class="btn role-primary btn-sm" :disabled="!newName || busy" @click="add">
        Create
      </button>
      <span class="hint">Provisions a new magic-closet instance on the host (own ports, sidecars, workspace)</span>
    </div>

    <table class="closets">
      <thead>
        <tr><th>Name</th><th>Sidecars</th><th>Auth</th><th>API Port</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="c in closets" :key="c.name" class="row" @click="open(c)">
          <td>{{ c.name }} <span v-if="c.local" class="tag">controller</span></td>
          <td>{{ sidecarText(c) }}</td>
          <td>{{ authText(c) }}</td>
          <td>{{ c.apiPort || '—' }}</td>
          <td @click.stop>
            <button v-if="!c.local && !c.op" class="btn role-link btn-sm" @click="remove(c)">Delete</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style lang="scss" scoped>
.closet-list {
  padding: 20px;

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
  }

  .banner.error {
    border: 1px solid var(--error);
    border-radius: 4px;
    padding: 10px;
    margin-bottom: 15px;

    .api-url {
      display: flex;
      gap: 8px;
      align-items: center;
      margin-top: 8px;
    }
  }

  .add-form {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 15px;

    input {
      max-width: 320px;
    }

    .hint {
      opacity: 0.7;
      font-size: 12px;
    }
  }

  table.closets {
    width: 100%;
    border-collapse: collapse;

    th {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }

    td {
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }

    .row {
      cursor: pointer;

      &:hover td {
        background: var(--sortable-table-row-bg, rgba(0, 0, 0, 0.05));
      }
    }

    .tag {
      font-size: 11px;
      opacity: 0.7;
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 1px 5px;
      margin-left: 6px;
    }
  }
}
</style>
