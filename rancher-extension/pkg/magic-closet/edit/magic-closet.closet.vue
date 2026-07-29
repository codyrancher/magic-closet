<script>
import CruResource from '@shell/components/CruResource';
import NameNsDescription from '@shell/components/form/NameNsDescription';
import FormValidation from '@shell/mixins/form-validation';
import { RcItemCard } from '@components/RcItemCard';
import { RcSection } from '@components/RcSection';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Checkbox } from '@components/Form/Checkbox';
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
  ghToken:             'GH_TOKEN',
  appcoEmail:          'APPCO_EMAIL',
  appcoToken:          'APPCO_TOKEN',
  awsAccessKey:        'AWS_ACCESS_KEY',
  awsSecretKey:        'AWS_SECRET_KEY',
  apiKey:              'FIGMA_API_KEY',
  gcpServiceAccountKey: 'GCP_SERVICE_ACCOUNT_KEY',
  azureClientId:       'AZURE_CLIENT_ID',
  azureClientSecret:   'AZURE_CLIENT_SECRET',
  azureSubscriptionId: 'AZURE_SUBSCRIPTION_ID',
  azureTenantId:       'AZURE_TENANT_ID',
};

// Params managed entirely by the chosen secret set — hidden from the closet
// form (they live on the Secret Sets page)
const SECRET_SET_KEYS = Object.keys(SECRET_PARAM_ENV);

// Create a closet, or edit an existing one's config. Wrapped in CruResource
// for the standard masthead + footer + validation.
export default {
  name: 'ClosetEdit',

  components: {
    CruResource, NameNsDescription, RcItemCard, RcSection, Checkbox, LabeledInput, LabeledSelect,
  },

  mixins: [FormValidation],

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
    if (!this.value.metadata) {
      this.value.metadata = { name: this.value.id || '' };
    }
    const editing = !!this.value?.spec?.namespace;

    return {
      busy:  false,
      errors: [],
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
      sidecars:      [],
      enabled:       {},
      paramEdits:    {},
      authProvider:  '',
      loaded:        false,
      optionValues:  {},
      // secrets
      secretSets:    [],
      secretSetName: '',
      // name required on create
      fvFormRuleSets: editing ? [] : [{ path: 'metadata.name', rules: ['required'] }],
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

    doneParams() {
      return { cluster: this.$route.params.cluster, product: EXPLORER, resource: CLOSET_TYPE };
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
      }
    },

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
        await Promise.all(this.sidecars.flatMap((sc) => (sc.params || [])
          .filter((p) => p.options)
          .map(async (p) => {
            try {
              const r = await rancherFetch(`${ this.apiBase }/sidecars/${ sc.name }/params/${ p.id }/options`);

              this.optionValues[`${ sc.name }::${ p.id }`] = (r.options || []).map((o) => (typeof o === 'object' ? o : { label: o, value: o }));
            } catch { /* suggestions are best-effort */ }
          })));
        this.loaded = true;
      } catch (e) {
        this.errors = [e.message];
      }
    },

    isSecretParam(p) {
      return SECRET_SET_KEYS.includes(p.id);
    },

    // Params to show on a sidecar card (secret-set-managed ones are hidden)
    visibleParams(s) {
      return (s.params || []).filter((p) => !this.isSecretParam(p));
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

    // CruResource @finish
    finish(cb) {
      return this.isEdit ? this.saveConfig(cb) : this.create(cb);
    },

    async saveConfig(cb) {
      this.errors = [];
      const failures = [];
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
        this.errors = failures;
        cb(false);

        return;
      }
      cb(true);
      this.$router.push({
        name:   'c-cluster-product-resource-id',
        params: { ...this.doneParams, id: this.value.metadata.name },
      });
    },

    async create(cb) {
      this.errors = [];
      try {
        const name = this.value.metadata.name;
        const secretValues = await this.resolveSecretValues();
        const config = {};

        for (const [id, env] of Object.entries(SECRET_PARAM_ENV)) {
          if (secretValues[id]) {
            config[env] = secretValues[id];
          }
        }
        await createCloset(name, this.createSidecars, config);
        this.refreshUntilListed(name);
        cb(true);
        this.$router.push({ name: 'c-cluster-product-resource', params: this.doneParams });
      } catch (e) {
        this.errors = [e.message];
        cb(false);
      }
    },

    // The helm app record can lag a few seconds behind the install call, and
    // the spoofed type is served from cache — force-refetch until the new
    // closet shows up so the list updates without a page reload
    async refreshUntilListed(name) {
      for (let i = 0; i < 15; i++) {
        const all = await this.$store.dispatch('cluster/findAll', { type: CLOSET_TYPE, opt: { force: true } });

        if ((all || []).some((c) => c.metadata?.name === name)) {
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    },

    cancel() {
      this.$router.push({ name: 'c-cluster-product-resource', params: this.doneParams });
    },
  },
};
</script>

<template>
  <CruResource
    :mode="mode"
    :resource="value"
    :can-yaml="false"
    :validation-passed="isEdit || fvFormIsValid"
    :errors="errors"
    :cancel-event="true"
    :finish-button-mode="isEdit ? 'edit' : 'create'"
    @finish="finish"
    @cancel="cancel"
    @error="e => errors = e"
  >
    <!-- Edit config for an existing closet -->
    <template v-if="isEdit">
      <div v-if="!loaded" class="hint">
        Loading current configuration…
      </div>

      <template v-else>
        <LabeledSelect
          class="secret-set-select"
          :mode="mode"
          label="Secret set"
          :value="secretSetName"
          :options="secretSetOptions"
          :searchable="false"
          @update:value="secretSetName = typeof $event === 'object' ? ($event && $event.value) : $event"
        />

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
                  <Checkbox
                    class="enable-toggle"
                    :value="!!enabled[s.name]"
                    :disabled="isView || (!!s.unsupported && s.status === 'not_created')"
                    label="Enabled"
                    @update:value="enabled[s.name] = $event"
                  />
                </div>
              </template>

              <template v-if="s.unsupported" #item-card-sub-header>
                <span class="unsupported">{{ s.unsupported }}</span>
              </template>

              <template #item-card-footer>
                <div v-if="enabled[s.name] && (visibleParams(s).length || s.name === 'rancher')" class="params">
                  <template v-for="p in visibleParams(s)" :key="p.id">
                    <Checkbox
                      v-if="p.type === 'boolean'"
                      :value="!!paramEdits[s.name][p.id] && paramEdits[s.name][p.id] !== 'false'"
                      :disabled="isView"
                      :label="p.id"
                      @update:value="paramEdits[s.name][p.id] = $event ? 'true' : ''"
                    />
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
      </template>
    </template>

    <!-- Create a new closet -->
    <template v-else>
      <NameNsDescription
        :value="value"
        :mode="mode"
        :namespaced="false"
        :description-hidden="true"
        :rules="{ name: fvGetAndReportPathRules('metadata.name') }"
      />

      <LabeledSelect
        class="secret-set-select"
        label="Secret set"
        :value="secretSetName"
        :options="secretSetOptions"
        :searchable="false"
        @update:value="secretSetName = typeof $event === 'object' ? ($event && $event.value) : $event"
      />

      <RcSection
        v-for="g in createGroups"
        :key="g.name"
        :title="g.name"
        type="primary"
        mode="with-header"
        class="edit-group"
      >
        <div class="toggle-rows">
          <Checkbox
            v-for="item in g.items"
            :key="item.key"
            :value="!!createSidecars[item.key]"
            :label="item.label"
            @update:value="createSidecars[item.key] = $event"
          />
        </div>
      </RcSection>
    </template>
  </CruResource>
</template>

<style lang="scss" scoped>
.hint {
  opacity: 0.8;
  margin: 10px 0 20px;
}

.edit-group {
  margin-top: 12px;
}

// Equal gap above (masthead divider) and below (first section)
.secret-set-select {
  margin: 20px 0;
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
</style>
