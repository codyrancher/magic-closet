<script>
import CruResource from '@shell/components/CruResource';
import NameNsDescription from '@shell/components/form/NameNsDescription';
import FormValidation from '@shell/mixins/form-validation';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { RcItemCard } from '@components/RcItemCard';
import { RcSection } from '@components/RcSection';
import { Checkbox } from '@components/Form/Checkbox';
import { LabeledInput } from '@components/Form/LabeledInput';
import {
  createCloset, listSecretSets, readSecretSet, setCluster, setSecretOwner,
} from '../api';
import { EXPLORER, CLOSET_TYPE } from '../product';

// Secret-set key -> chart config env var, injected at create time
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

// The fixed set of sidecars a closet can run (there's no closet api to query at
// create time). Rendered as the same cards as the detail view, each with an
// enable toggle + the create-time options that map to the chart's config.
// vscode is shown last in Dev; the params here mirror what the detail page's
// Configuration shows.
const SIDECAR_CATALOG = [
  {
    key: 'rancher', name: 'rancher', group: 'Dev', description: 'Rancher server. First start ~10 min.',
    params: [
      {
        id: 'auth', label: 'Rancher auth', type: 'select', env: 'RANCHER_AUTH_PROVIDER', default: 'keycloak',
        options: [
          { label: 'None', value: '' },
          { label: 'Keycloak (OIDC)', value: 'keycloak' },
          { label: 'Keycloak (SAML)', value: 'keycloak-saml' },
          { label: 'OpenLDAP', value: 'openldap' },
        ],
      },
      { id: 'prime', label: 'Prime', type: 'boolean', env: 'RANCHER_PRIME' },
    ],
  },
  { key: 'rancherBrowser', name: 'rancher-browser', group: 'Dev', description: 'Chromium with Rancher quick-login.' },
  {
    key: 'vscode', name: 'vscode', group: 'Dev', description: 'VS Code editing /workspace.',
    params: [{ id: 'githubUrl', label: 'GitHub URL (repo, PR, or issue)', type: 'text', env: 'GITHUB_URL' }],
  },
  { key: 'keycloak', name: 'keycloak', group: 'Auth', description: 'Keycloak OIDC/SAML provider.' },
  { key: 'openldap', name: 'openldap', group: 'Auth', description: 'OpenLDAP directory server.' },
  { key: 'figma', name: 'figma', group: 'Design', description: 'Figma MCP server.' },
];

const GROUP_ORDER = ['Dev', 'Auth', 'Design'];

// Create a closet: name + secret set, then toggle/configure sidecars.
export default {
  name: 'ClosetCreate',

  components: {
    CruResource, NameNsDescription, LabeledSelect, RcItemCard, RcSection, Checkbox, LabeledInput,
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
    // Seed per-sidecar param values from their defaults
    const paramEdits = {};

    for (const s of SIDECAR_CATALOG) {
      paramEdits[s.key] = {};
      for (const p of s.params || []) {
        paramEdits[s.key][p.id] = p.default ?? '';
      }
    }

    return {
      errors:        [],
      enabled:       {
        rancher: true, rancherBrowser: true, vscode: false, keycloak: true, openldap: false, figma: false,
      },
      paramEdits,
      secretSets:    [],
      secretSetName: '',
      fvFormRuleSets: [{ path: 'metadata.name', rules: ['required'] }],
    };
  },

  computed: {
    groups() {
      const names = [...new Set(SIDECAR_CATALOG.map((s) => s.group))]
        .sort((a, b) => (GROUP_ORDER.indexOf(a) < 0 ? 99 : GROUP_ORDER.indexOf(a)) - (GROUP_ORDER.indexOf(b) < 0 ? 99 : GROUP_ORDER.indexOf(b)));

      return names.map((name) => ({ name, sidecars: SIDECAR_CATALOG.filter((s) => s.group === name) }));
    },

    secretSetOptions() {
      return [
        { label: 'None (no secrets)', value: '' },
        ...this.secretSets.map((set) => ({ label: set.isDefault ? `${ set.name } (default)` : set.name, value: set.name })),
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
  },

  methods: {
    async loadSecretSets() {
      this.secretSets = await listSecretSets();
      const def = this.secretSets.find((x) => x.isDefault);

      if (def && !this.secretSetName) {
        this.secretSetName = def.name;
      }
    },

    async create(cb) {
      this.errors = [];
      try {
        const config = {};

        // Per-sidecar options from enabled sidecars -> chart config
        for (const s of SIDECAR_CATALOG) {
          if (!this.enabled[s.key]) {
            continue;
          }
          for (const p of s.params || []) {
            const v = this.paramEdits[s.key][p.id];

            if (p.type === 'boolean') {
              if (v && v !== 'false') {
                config[p.env] = 'true';
              }
            } else if (v) {
              config[p.env] = v;
            }
          }
        }
        // Secret set values -> chart config
        const secretValues = this.secretSetName ? await readSecretSet(this.secretSetName).catch(() => ({})) : {};

        for (const [id, env] of Object.entries(SECRET_PARAM_ENV)) {
          if (secretValues[id]) {
            config[env] = secretValues[id];
          }
        }

        await createCloset(this.value.metadata.name, this.enabled, config);
        this.refreshUntilListed(this.value.metadata.name);
        cb(true);
        this.$router.push({ name: 'c-cluster-product-resource', params: this.doneParams });
      } catch (e) {
        this.errors = [e.message];
        cb(false);
      }
    },

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
    :validation-passed="fvFormIsValid"
    :errors="errors"
    :cancel-event="true"
    @finish="create"
    @cancel="cancel"
    @error="e => errors = e"
  >
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
      v-for="group in groups"
      :key="group.name"
      :title="group.name"
      type="primary"
      mode="with-header"
      class="sidecar-group"
    >
      <div class="cards">
        <rc-item-card
          v-for="s in group.sidecars"
          :id="`sidecar-${s.key}`"
          :key="s.key"
          :header="{}"
          variant="medium"
        >
          <template #item-card-header-title>
            <div class="title-row">
              <h3 class="item-card-header-title medium">
                {{ s.name }}
              </h3>
              <Checkbox
                class="enable-toggle"
                :value="!!enabled[s.key]"
                label="Enabled"
                @update:value="enabled[s.key] = $event"
              />
            </div>
          </template>

          <template #item-card-sub-header>
            <div v-if="s.description" class="desc">
              {{ s.description }}
            </div>
          </template>

          <template v-if="s.params && s.params.length" #item-card-footer>
            <details class="config" :open="enabled[s.key]">
              <summary>Configuration</summary>
              <div class="config-body">
                <template v-for="p in s.params" :key="p.id">
                  <Checkbox
                    v-if="p.type === 'boolean'"
                    :value="paramEdits[s.key][p.id] === 'true'"
                    :label="p.label"
                    :disabled="!enabled[s.key]"
                    @update:value="paramEdits[s.key][p.id] = $event ? 'true' : ''"
                  />
                  <LabeledSelect
                    v-else-if="p.type === 'select'"
                    :label="p.label"
                    :value="paramEdits[s.key][p.id]"
                    :options="p.options"
                    :searchable="false"
                    :disabled="!enabled[s.key]"
                    @update:value="paramEdits[s.key][p.id] = typeof $event === 'object' ? ($event && $event.value) : $event"
                  />
                  <LabeledInput
                    v-else
                    v-model:value="paramEdits[s.key][p.id]"
                    :label="p.label"
                    :disabled="!enabled[s.key]"
                  />
                </template>
              </div>
            </details>
          </template>
        </rc-item-card>
      </div>
    </RcSection>
  </CruResource>
</template>

<style lang="scss" scoped>
.secret-set-select { margin: 20px 0; }

.sidecar-group { margin-top: 12px; }

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}

.title-row {
  display: flex;
  align-items: center;
  width: 100%;

  h3 { margin: 0; }

  .enable-toggle { margin-left: auto; }
}

.desc { color: var(--input-label, var(--muted)); font-size: 13px; }

.config {
  width: 100%;
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
}
</style>
