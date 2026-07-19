<script>
import { closetApiBase, deleteCloset, listClosets, setCluster } from '../api';

export default {
  name: 'ClosetList',

  data() {
    return { closets: [], status: {}, error: null };
  },

  created() {
    setCluster(this.$route.params.cluster);
    this.load();
    this.timer = setInterval(this.load, 8000);
  },

  beforeUnmount() {
    clearInterval(this.timer);
  },

  methods: {
    async load() {
      try {
        this.closets = await listClosets();
        this.error = null;
        this.probe();
      } catch (e) {
        this.error = e.message;
      }
    },

    // Each closet runs its own api — ask it for live sidecar status through
    // the same-origin service proxy
    async probe() {
      for (const c of this.closets) {
        try {
          const resp = await fetch(`${ closetApiBase(c.namespace) }/sidecars`);
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

    sidecarText(c) {
      const s = this.status[c.name];

      return s ? `${ s.running }/${ s.total } running` : '—';
    },

    open(closet) {
      this.$router.push({
        name:   `c-cluster-magicCloset-closet`,
        params: { cluster: this.$route.params.cluster, closet: closet.name },
      });
    },

    async remove(closet) {
      try {
        await deleteCloset(closet);
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
      <button class="btn role-primary" @click="$router.push({ name: 'c-cluster-magicCloset-create', params: { cluster: $route.params.cluster } })">
        Create Closet
      </button>
    </header>

    <div v-if="error" class="banner error">{{ error }}</div>

    <table class="closets">
      <thead>
        <tr><th>Name</th><th>State</th><th>Sidecars</th><th>Auth</th><th>Namespace</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="c in closets" :key="c.name" class="row" @click="open(c)">
          <td>{{ c.name }}</td>
          <td>{{ c.state }}</td>
          <td>{{ sidecarText(c) }}</td>
          <td>{{ status[c.name]?.authProvider || '—' }}</td>
          <td>{{ c.namespace }}</td>
          <td @click.stop>
            <button class="btn role-link btn-sm" @click="remove(c)">Delete</button>
          </td>
        </tr>
        <tr v-if="!closets.length && !error">
          <td colspan="6" class="empty">No closets yet — create one.</td>
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
  }

  table.closets {
    width: 100%;
    border-collapse: collapse;

    th, td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--border);
    }

    .row { cursor: pointer; }

    .row:hover td {
      background: var(--sortable-table-row-bg, rgba(0, 0, 0, 0.05));
    }

    .empty {
      opacity: 0.7;
    }
  }
}
</style>
