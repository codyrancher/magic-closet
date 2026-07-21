<script>
import { RcButton } from '@components/RcButton';
import { RcItemCard } from '@components/RcItemCard';
import { RcSection } from '@components/RcSection';
import { ToggleSwitch } from '@components/Form/ToggleSwitch';
import { LabeledInput } from '@components/Form/LabeledInput';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import {
  closetApiBase, createCloset, listSecretSets, rancherFetch,
  readSecretSet, setCluster, setSecretOwner,
} from '../api';
import { EXPLORER, CLOSET_TYPE } from '../product';

const GROUP_ORDER = ['dev', 'auth', 'design'];

// Secret-style param id -> chart config env var, for injecting a chosen
// secret set's values at closet-create time
const SECRET_PARAM_ENV = {
  ghToken:      'GH_TOKEN',
  appcoToken:   'APPCO_TOKEN',
  awsAccessKey: 'AWS_ACCESS_KEY',
  awsSecretKey: 'AWS_SECRET_KEY',
  apiKey:       'FIGMA_API_KEY',
};

// Create a closet, or edit an existing one's config: which sidecars run,
// their params, and the active Rancher auth provider. Secret-style params are
// filled from a chosen secret set (managed under Configure Secrets).
export default {
  name: 'ClosetEdit',

  components: {
    RcButton, RcItemCard, RcSection, ToggleSwitch, LabeledInput, LabeledSelect,
  },

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
      createGroups: [
        {
          name:  'Dev',
          items: [
            { key: 'vscode', label: 'VS Code' },
            { key: 'rancher', label: 'Rancher server (first start ~10 min)' },
            { key: 'rancherBrowser', label: 'Chromium browser' },
          ],
        },
        {
          name:  'Auth',
          items: [
            { key: 'keycloak', label: 'Keycloak (OIDC)' },
            { key: 'openldap', label: 'OpenLDAP' },
          ],
        },
        {
          name:  'Design',
          items: [{ key: 'figma', label: 'Figma MCP' }],
        },
      ],
      // edit mode
      sidecars:        [],
      enabled:         {},
      paramEdits:      {},
      authProvider:    '',
      loaded:          false,
      optionValues:    {},
      // secrets
      secretSets:      [],
      secretSetName:   '',
      secretSetPicked: false,
    };
  },

  computed: {
    isEdit() {
      return !!this.value?.spec?.namespace;
    },

    isView() {
      return this.mode === 'view';
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
          modes.push({
            value:    m.value,
            label:    `${ s.name }: ${ m.label }`,
            // Only selectable when the backing sidecar will be up
            disabled: !this.enabled[s.name],
          });
        }
      }

      return modes;
    },

    secretSetOptions() {
      return [
        { label: 'None (no secrets)', value: '' },
        ...this.secretSets.map((set) => ({
          label: set.isDefault ? `${ set.name } (default)` : set.name,
          value: set.name,
        })),
      ];
    },

    // In create mode a set must be chosen before the rest of the form shows
    secretSetChosen() {
      return this.secretSetPicked;
    },
  },

  created() {
    setCluster(this.$route.params.cluster);
    setSecretOwner(this.$store.getters['auth/principalId']);
    this.loadSecretSets();
    if (this.isEdit) {
      this.load();
    }
  },

  methods: {
    async loadSecretSets() {
      this.secretSets = await listSecretSets();
      const def = this.secretSets.find((x) => x.isDefault);

      if (def && !this.secretSetName) {
        this.secretSetName = def.name;
        this.secretSetPicked = true;
      }
    },

    onSecretSet(val) {
      this.secretSetName = typeof val === 'object' ? (val && val.value) : val;
      this.secretSetPicked = true;
    },

    // Resolve the chosen secret set's values, keyed by param id
    async resolveSecretValues() {
      if (!this.secretSetName) {
        return {};
      }

      return readSecretSet(this.secretSetName).catch(() => ({}));
    },

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
        // Suggested values for params with an options source (taggable)
        await Promise.all(this.sidecars.flatMap((sc) => (sc.params || [])
          .filter((p) => p.options)
          .map(async (p) => {
            try {
              const r = await rancherFetch(`${ this.apiBase }/sidecars/${ sc.name }/params/${ p.id }/options`);

              this.optionValues[`${ sc.name }::${ p.id }`] = (r.options || []).map((o) => o.value ?? o);
            } catch { /* suggestions are best-effort */ }
          })));
        this.loaded = true;
      } catch (e) {
        this.error = e.message;
      }
    },

    // Secret-style params are filled from the chosen secret set
    isSecretParam(p) {
      return /(token|secret|key|password)$/i.test(p.id);
    },

    cardFor(s) {
      return { id: `sidecar-${ s.name }`, header: {} };
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

      // Fill secret-style params from the chosen secret set (by param id)
      const secretValues = await this.resolveSecretValues();

      for (const sc of this.sidecars) {
        for (const p of sc.params || []) {
          if (this.isSecretParam(p) && secretValues[p.id] !== undefined) {
            this.paramEdits[sc.name][p.id] = secretValues[p.id];
          }
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
        const secretValues = await this.resolveSecretValues();
        const config = {};

        for (const [id, env] of Object.entries(SECRET_PARAM_ENV)) {
          if (secretValues[id]) {
            config[env] = secretValues[id];
          }
        }
        await createCloset(this.name, this.createSidecars, config);
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
      <RcSection
        title="Secrets"
        type="primary"
        mode="with-header"
        class="edit-group"
      >
        <LabeledSelect
          class="secret-set-select"
          :mode="mode"
          label="Secret set"
          :value="secretSetName"
          :options="secretSetOptions"
          :searchable="false"
          @update:value="onSecretSet($event)"
        />
      </RcSection>

      <RcSection
        v-for="group in groups"
        :key="group.name"
        :title="group.name.charAt(0).toUpperCase() + group.name.slice(1)"
        type="primary"
        mode="with-header"
        class="edit-group"
      >
        <div class="cards">
          <rc-item-card
            v-for="s in group.sidecars"
            :id="`sidecar-${s.name}`"
            :key="s.name"
            v-bind="cardFor(s)"
            variant="medium"
          >
            <template #item-card-header-title>
              <div class="title-row">
                <h3 class="item-card-header-title medium">
                  {{ s.name }}
                </h3>
                <ToggleSwitch
                  class="enable-toggle"
                  :value="!!enabled[s.name]"
                  :disabled="isView || (!!s.unsupported && s.status === 'not_created')"
                  @update:value="enabled[s.name] = $event"
                />
              </div>
            </template>

            <template #item-card-sub-header>
              <div class="sub">
                <div class="desc">
                  {{ s.description }}
                </div>
                <span v-if="s.unsupported" class="unsupported">{{ s.unsupported }}</span>
              </div>
            </template>

            <template #item-card-footer>
              <div v-if="enabled[s.name] && ((s.params || []).length || s.name === 'rancher')" class="params">
                <template v-for="p in s.params" :key="p.id">
                  <div v-if="p.type === 'boolean'" class="param-row">
                    <label :for="`${s.name}-${p.id}`">{{ p.id }}</label>
                    <ToggleSwitch
                      :id="`${s.name}-${p.id}`"
                      :value="!!paramEdits[s.name][p.id] && paramEdits[s.name][p.id] !== 'false'"
                      :disabled="isView"
                      @update:value="paramEdits[s.name][p.id] = $event ? 'true' : ''"
                    />
                  </div>
                  <LabeledSelect
                    v-else-if="p.options"
                    :mode="mode"
                    :label="p.id"
                    :value="paramEdits[s.name][p.id]"
                    :options="optionValues[`${s.name}::${p.id}`] || []"
                    :taggable="true"
                    :searchable="true"
                    @update:value="paramEdits[s.name][p.id] = typeof $event === 'object' ? ($event && $event.value) : $event"
                  />
                  <div v-else-if="isSecretParam(p)" class="param-row">
                    <label>{{ p.id }}</label>
                    <span class="param-value">from secret set</span>
                  </div>
                  <LabeledInput
                    v-else
                    v-model:value="paramEdits[s.name][p.id]"
                    :mode="mode"
                    :label="p.id"
                    :placeholder="p.default || ''"
                  />
                </template>
                <LabeledSelect
                  v-if="s.name === 'rancher'"
                  class="auth-select"
                  :mode="mode"
                  label="rancher auth"
                  :value="authProvider"
                  :options="authModes"
                  :searchable="false"
                  @update:value="authProvider = typeof $event === 'object' ? ($event && $event.value) : $event"
                />
              </div>
            </template>
          </rc-item-card>
        </div>
      </RcSection>

      <div v-if="!isView" class="actions">
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
  <div v-else class="closet-create create">
    <p class="hint">
      Installs a closet into this cluster (namespace <code>closet-&lt;name&gt;</code>):
      a project workspace plus the sidecars you pick, managed by the closet's
      own dashboard.
    </p>

    <div v-if="error" class="banner error">
      {{ error }}
    </div>

    <RcSection
      title="Secrets"
      type="primary"
      mode="with-header"
      class="edit-group"
    >
      <LabeledSelect
        class="secret-set-select"
        label="Secret set"
        :value="secretSetName"
        :options="secretSetOptions"
        :searchable="false"
        @update:value="onSecretSet($event)"
      />
      <p class="hint">
        Choose a secret set first. Manage sets on the <b>Secret Sets</b> page.
      </p>
    </RcSection>

    <template v-if="secretSetChosen">
      <div class="form">
        <label>Name</label>
        <input v-model="name" placeholder="e.g. pr-18387" @keyup.enter="create">
      </div>

      <RcSection
        v-for="g in createGroups"
        :key="g.name"
        :title="g.name"
        type="primary"
        mode="with-header"
        class="edit-group"
      >
        <div class="toggle-rows">
          <div v-for="item in g.items" :key="item.key" class="toggle-row">
            <span>{{ item.label }}</span>
            <ToggleSwitch
              :value="!!createSidecars[item.key]"
              @update:value="createSidecars[item.key] = $event"
            />
          </div>
        </div>
      </RcSection>
    </template>

    <div class="actions">
      <rc-button variant="secondary" @click="done()">
        Cancel
      </rc-button>
      <rc-button variant="primary" :disabled="!name || !secretSetChosen || busy" @click="create">
        {{ busy ? 'Creating…' : 'Create' }}
      </rc-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.closet-create {
  padding: 20px 0 40px 0;

  &.create {
    max-width: 640px;
    padding: 20px;
  }

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

  .edit-group {
    margin-top: 12px;
  }

  .secret-set-select {
    max-width: 440px;
  }

  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 16px;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;

    h3 {
      margin: 0;
    }

    .enable-toggle {
      margin-left: auto;
    }
  }

  .sub {
    display: flex;
    flex-direction: column;
    gap: 4px;

    .desc {
      color: var(--body-text);
    }
  }

  .params {
    display: flex;
    flex-direction: column;
    gap: 10px;
    width: 100%;
  }

  .unsupported {
    font-style: italic;
    color: var(--muted);
    font-size: 12px;
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

    .param-value {
      font-size: 13px;
      color: var(--muted);
      font-style: italic;
    }
  }

  .toggle-rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 440px;

    .toggle-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
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
  }

  .actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
    margin-top: 20px;
  }
}
</style>
