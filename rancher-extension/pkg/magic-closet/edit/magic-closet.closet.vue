<script>
import { createCloset, setCluster } from '../api';
import { EXPLORER, CLOSET_TYPE } from '../product';

export default {
  name: 'ClosetCreate',

  props: {
    value: {
      type:    Object,
      default: () => ({}),
    },
    mode: {
      type:    String,
      default: 'create',
    },
  },

  data() {
    return {
      name:     '',
      busy:     false,
      error:    null,
      sidecars: {
        vscode:         true,
        rancher:        true,
        keycloak:       true,
        rancherBrowser: false,
        openldap:       false,
        figma:          false,
      },
      labels: {
        vscode:         'VS Code',
        rancher:        'Rancher server (first start ~10 min)',
        keycloak:       'Keycloak (OIDC)',
        rancherBrowser: 'Chromium browser',
        openldap:       'OpenLDAP',
        figma:          'Figma MCP',
      },
    };
  },

  created() {
    setCluster(this.$route.params.cluster);
  },

  methods: {
    async create() {
      this.busy = true;
      this.error = null;
      try {
        await createCloset(this.name, this.sidecars);
        this.refreshUntilListed(this.name);
        this.done();
      } catch (e) {
        this.error = e.message;
        this.busy = false;
      }
    },

    // The helm app record can lag a few seconds behind the install call, and
    // the spoofed type is served from cache — force-refetch until the new
    // closet shows up so the list updates without a page reload
    async refreshUntilListed(name) {
      const store = this.$store;

      for (let i = 0; i < 15; i++) {
        const all = await store.dispatch('cluster/findAll', { type: CLOSET_TYPE, opt: { force: true } });

        if ((all || []).some((c) => c.metadata?.name === name)) {
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    },

    done() {
      this.$router.push({
        name:   'c-cluster-product-resource',
        params: { cluster: this.$route.params.cluster, product: EXPLORER, resource: CLOSET_TYPE },
      });
    },
  },
};
</script>

<template>
  <div class="closet-create">
    <p class="hint">
      Installs a closet into this cluster (namespace <code>closet-&lt;name&gt;</code>):
      a project workspace plus the sidecars you pick, managed by the closet's
      own dashboard.
    </p>

    <div v-if="error" class="banner error">{{ error }}</div>

    <div class="form">
      <label>Name</label>
      <input v-model="name" placeholder="e.g. pr-18387" @keyup.enter="create" />
    </div>

    <div class="form">
      <label>Sidecars</label>
      <div class="checks">
        <label v-for="(on, key) in sidecars" :key="key" class="check">
          <input v-model="sidecars[key]" type="checkbox" />
          {{ labels[key] }}
        </label>
      </div>
    </div>

    <div class="actions">
      <button class="btn role-secondary" @click="done">Cancel</button>
      <button class="btn role-primary" :disabled="!name || busy" @click="create">
        {{ busy ? 'Creating…' : 'Create' }}
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.closet-create {
  padding: 20px;
  max-width: 560px;

  .hint {
    opacity: 0.8;
    margin: 10px 0 20px;
  }

  .banner.error {
    border: 1px solid var(--error);
    border-radius: 4px;
    padding: 10px;
    margin-bottom: 15px;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 20px;

    > label {
      opacity: 0.8;
      font-size: 13px;
    }

    .checks {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px;

      .check {
        display: flex;
        gap: 8px;
        align-items: center;
      }
    }
  }

  .actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }
}
</style>
