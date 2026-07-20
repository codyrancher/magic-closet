<script>
import { RcButton } from '@components/RcButton';
import {
  closetApiBase, createCloset, createSharedSecret, listSharedSecrets,
  rancherFetch, readSharedSecret, setCluster,
} from '../api';
import { EXPLORER, CLOSET_TYPE } from '../product';

const GROUP_ORDER = ['dev', 'auth', 'design'];

// Create a closet, or edit an existing one's config: which sidecars run,
// their params, and the active Rancher auth provider. Saving applies the
// diff through the closet's api (start/stop/auth apply).
export default {
  name: 'ClosetEdit',

  components: { RcButton },

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
      name:      '',
      busy:      false,
      error:     null,
      // create mode
      createSidecars: {
        vscode:         true,
        rancher:        true,
        keycloak:       true,
        rancherBrowser: false,
        openldap:       false,
        figma:          false,
      },
      createLabels: {
        vscode:         'VS Code',
        rancher:        'Rancher server (first start ~10 min)',
        keycloak:       'Keycloak (OIDC)',
        rancherBrowser: 'Chromium browser',
        openldap:       'OpenLDAP',
        figma:          'Figma MCP',
      },
      // edit mode
      sidecars:      [],
      enabled:       {},
      paramEdits:    {},
      authProvider:  '',
      loaded:        false,
      sharedSecrets: [],
      secretSel:     {},
      newSecret:     { name: '', value: '', busy: false },
    };
  },

  computed: {
    isEdit() {
      return !!this.value?.spec?.namespace;
    },

    apiBase() {
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

    authModes() {
      const modes = [{ value: '', label: 'None' }];

      for (const s of this.sidecars) {
        for (const m of s.rancherAuth?.modes || []) {
          modes.push({ value: m.value, label: `${ s.name }: ${ m.label }` });
        }
      }

      return modes;
    },
  },

  created() {
    setCluster(this.$route.params.cluster);
    if (this.isEdit) {
      this.load();
    }
  },

  methods: {
    async load() {
      try {
        const data = await rancherFetch(`${ this.apiBase }/sidecars`);

        this.sidecars = data.sidecars || [];
        this.authProvider = data.rancher?.authProvider || '';
        for (const s of this.sidecars) {
          this.enabled[s.name] = s.status === 'running';
          const edits = {};

          for (const p of s.params || []) {
            edits[p.id] = p.value ?? p.default ?? '';
          }
          this.paramEdits[s.name] = edits;
        }
        this.sharedSecrets = await listSharedSecrets();
        this.loaded = true;
      } catch (e) {
        this.error = e.message;
      }
    },

    // Token/secret-style params are backed by shared k8s Secrets (namespace
    // magic-closet-secrets) so they can be reused between closets
    isSecretParam(p) {
      return /(token|secret|key|password)$/i.test(p.id);
    },

    async addSharedSecret() {
      const { name, value } = this.newSecret;

      if (!name || !value) {
        return;
      }
      this.newSecret.busy = true;
      try {
        await createSharedSecret(name, value);
        if (!this.sharedSecrets.includes(name)) {
          this.sharedSecrets = [...this.sharedSecrets, name].sort();
        }
        this.newSecret = { name: '', value: '', busy: false };
      } catch (e) {
        this.error = `secret: ${ e.message }`;
        this.newSecret.busy = false;
      }
    },

    startBody(s) {
      const params = { ...(this.paramEdits[s.name] || {}) };

      for (const p of s.params || []) {
        if (p.type === 'boolean') {
          params[p.id] = params[p.id] && params[p.id] !== 'false' ? 'true' : '';
        }
      }

      return { params };
    },

    paramsChanged(s) {
      return (s.params || []).some((p) => (this.paramEdits[s.name]?.[p.id] ?? '') !== (p.value ?? p.default ?? ''));
    },

    async save() {
      this.busy = true;
      this.error = null;
      const failures = [];

      // Resolve selected shared secrets into param values first
      for (const [key, secretName] of Object.entries(this.secretSel)) {
        if (!secretName) {
          continue;
        }
        const [sidecar, paramId] = key.split('::');

        try {
          this.paramEdits[sidecar][paramId] = await readSharedSecret(secretName);
        } catch (e) {
          failures.push(`secret ${ secretName }: ${ e.message }`);
        }
      }

      for (const s of this.sidecars) {
        if (s.unsupported && s.status === 'not_created') {
          continue;
        }
        const wasRunning = s.status === 'running';
        const want = !!this.enabled[s.name];

        try {
          if (want && (!wasRunning || this.paramsChanged(s))) {
            await rancherFetch(`${ this.apiBase }/sidecars/${ s.name }/start`, {
              method: 'POST',
              body:   JSON.stringify(this.startBody(s)),
            });
          } else if (!want && wasRunning) {
            await rancherFetch(`${ this.apiBase }/sidecars/${ s.name }/stop`, { method: 'POST' });
          }
        } catch (e) {
          failures.push(`${ s.name }: ${ e.message }`);
        }
      }

      const currentAuth = (await rancherFetch(`${ this.apiBase }/sidecars`).catch(() => null))?.rancher?.authProvider || '';

      if (this.authProvider && this.authProvider !== currentAuth) {
        try {
          await rancherFetch(`${ this.apiBase }/auth/apply`, {
            method: 'POST',
            body:   JSON.stringify({ provider: this.authProvider }),
          });
        } catch (e) {
          failures.push(`auth: ${ e.message }`);
        }
      }

      if (failures.length) {
        this.error = failures.join(' — ');
        this.busy = false;

        return;
      }
      this.done(true);
    },

    async create() {
      this.busy = true;
      this.error = null;
      try {
        await createCloset(this.name, this.createSidecars);
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

    done(toDetail = false) {
      if (toDetail && this.isEdit) {
        this.$router.push({
          name:   'c-cluster-product-resource-id',
          params: {
            cluster: this.$route.params.cluster, product: EXPLORER, resource: CLOSET_TYPE, id: this.value.metadata.name,
          },
        });

        return;
      }
      this.$router.push({
        name:   'c-cluster-product-resource',
        params: { cluster: this.$route.params.cluster, product: EXPLORER, resource: CLOSET_TYPE },
      });
    },
  },
};
</script>

<template>
  <!-- Edit config for an existing closet -->
  <div v-if="isEdit" class="closet-create">
    <div v-if="error" class="banner error">
      {{ error }}
    </div>

    <div v-if="!loaded" class="hint">
      Loading current configuration…
    </div>

    <template v-else>
      <div v-for="group in groups" :key="group.name" class="edit-group">
        <h3 class="group-title">
          {{ group.name }}
        </h3>
        <div v-for="s in group.sidecars" :key="s.name" class="sidecar-row">
          <label class="check head">
            <input
              v-model="enabled[s.name]"
              type="checkbox"
              :disabled="!!s.unsupported && s.status === 'not_created'"
            >
            <span class="sidecar-name">{{ s.name }}</span>
            <span v-if="s.unsupported" class="unsupported">{{ s.unsupported }}</span>
          </label>
          <div v-if="enabled[s.name] && (s.params || []).length" class="params">
            <div v-for="p in s.params" :key="p.id" class="param-row">
              <label :for="`${s.name}-${p.id}`">{{ p.id }}</label>
              <input
                v-if="p.type === 'boolean'"
                :id="`${s.name}-${p.id}`"
                type="checkbox"
                :checked="!!paramEdits[s.name][p.id] && paramEdits[s.name][p.id] !== 'false'"
                @change="paramEdits[s.name][p.id] = $event.target.checked ? 'true' : ''"
              >
              <select
                v-else-if="isSecretParam(p)"
                :id="`${s.name}-${p.id}`"
                v-model="secretSel[`${s.name}::${p.id}`]"
              >
                <option value="">
                  {{ paramEdits[s.name][p.id] ? '(keep current value)' : '(none)' }}
                </option>
                <option v-for="n in sharedSecrets" :key="n" :value="n">
                  secret: {{ n }}
                </option>
              </select>
              <input
                v-else
                :id="`${s.name}-${p.id}`"
                v-model="paramEdits[s.name][p.id]"
                type="text"
                :placeholder="p.default || ''"
              >
            </div>
          </div>
        </div>
      </div>

      <div class="edit-group">
        <h3 class="group-title">
          rancher auth
        </h3>
        <div class="param-row">
          <label for="auth-provider">provider</label>
          <select id="auth-provider" v-model="authProvider">
            <option v-for="m in authModes" :key="m.value" :value="m.value">
              {{ m.label }}
            </option>
          </select>
        </div>
      </div>

      <div class="edit-group">
        <h3 class="group-title">
          shared secrets
        </h3>
        <p class="hint">
          Reusable across closets (stored as Secrets in
          <code>magic-closet-secrets</code>); pick them from the dropdowns above.
        </p>
        <div class="param-row">
          <label for="new-secret-name">new secret</label>
          <input
            id="new-secret-name"
            v-model="newSecret.name"
            type="text"
            placeholder="name (e.g. my-gh-token)"
          >
          <input
            v-model="newSecret.value"
            type="password"
            placeholder="value"
          >
          <rc-button
            variant="secondary"
            :disabled="!newSecret.name || !newSecret.value || newSecret.busy"
            @click="addSharedSecret"
          >
            Add
          </rc-button>
        </div>
      </div>

      <div class="actions">
        <rc-button variant="secondary" @click="done(true)">
          Cancel
        </rc-button>
        <rc-button variant="primary" :disabled="busy" @click="save">
          {{ busy ? 'Saving…' : 'Save' }}
        </rc-button>
      </div>
    </template>
  </div>

  <!-- Create a new closet -->
  <div v-else class="closet-create">
    <p class="hint">
      Installs a closet into this cluster (namespace <code>closet-&lt;name&gt;</code>):
      a project workspace plus the sidecars you pick, managed by the closet's
      own dashboard.
    </p>

    <div v-if="error" class="banner error">
      {{ error }}
    </div>

    <div class="form">
      <label>Name</label>
      <input v-model="name" placeholder="e.g. pr-18387" @keyup.enter="create">
    </div>

    <div class="form">
      <label>Sidecars</label>
      <div class="checks">
        <label v-for="(on, key) in createSidecars" :key="key" class="check">
          <input v-model="createSidecars[key]" type="checkbox">
          {{ createLabels[key] }}
        </label>
      </div>
    </div>

    <div class="actions">
      <rc-button variant="secondary" @click="done()">
        Cancel
      </rc-button>
      <rc-button variant="primary" :disabled="!name || busy" @click="create">
        {{ busy ? 'Creating…' : 'Create' }}
      </rc-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.closet-create {
  padding: 20px;
  max-width: 640px;

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

  .group-title {
    text-transform: uppercase;
    letter-spacing: 1px;
    font-size: 13px;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    padding-bottom: 4px;
    margin: 20px 0 12px 0;
  }

  .sidecar-row {
    margin-bottom: 12px;

    .check.head {
      display: flex;
      gap: 8px;
      align-items: baseline;

      .sidecar-name {
        font-weight: 600;
      }
    }

    .unsupported {
      font-style: italic;
      color: var(--muted);
      font-size: 12px;
    }

    .params {
      margin: 6px 0 0 24px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-width: 440px;
    }
  }

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

    input[type='text'], input[type='password'], select {
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
    margin-top: 20px;
  }
}
</style>
