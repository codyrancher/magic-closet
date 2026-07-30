<script>
import CruResource from '@shell/components/CruResource';
import NameNsDescription from '@shell/components/form/NameNsDescription';
import FormValidation from '@shell/mixins/form-validation';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { RcSection } from '@components/RcSection';
import { Checkbox } from '@components/Form/Checkbox';
import SidecarCard from '../components/SidecarCard';
import {
  createCloset, listSecretSets, readSecretSet, setCluster, setSecretOwner,
  registerPendingCloset, clearPendingCloset,
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

// The fixed set of sidecars a closet can run (no closet api to query at create
// time). Rendered with the same SidecarCard as the detail view, each with an
// enable toggle. `params` carry an `env` used to build the chart config.
// vscode is shown last in Dev.
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
  { key: 'vscode', name: 'vscode', group: 'Dev', description: 'VS Code editing /workspace.' },
  { key: 'keycloak', name: 'keycloak', group: 'Auth', description: 'Keycloak OIDC/SAML provider.' },
  { key: 'openldap', name: 'openldap', group: 'Auth', description: 'OpenLDAP directory server.' },
  { key: 'figma', name: 'figma', group: 'Design', description: 'Figma MCP server.' },
];

const GROUP_ORDER = ['Dev', 'Auth', 'Design'];

// Create a closet: name + secret set, then toggle/configure sidecars.
export default {
  name: 'ClosetCreate',

  components: {
    CruResource, NameNsDescription, LabeledSelect, RcSection, Checkbox, SidecarCard,
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
      const name = this.value.metadata.name;

      try {
        const config = {};

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
        const secretValues = this.secretSetName ? await readSecretSet(this.secretSetName).catch(() => ({})) : {};

        for (const [id, env] of Object.entries(SECRET_PARAM_ENV)) {
          if (secretValues[id]) {
            config[env] = secretValues[id];
          }
        }

        // Kick off the install, then show the closet in the list right away
        // (optimistic) and navigate — no waiting for the Helm app to appear.
        await createCloset(name, this.enabled, config);
        registerPendingCloset(name);
        await this.$store.dispatch('cluster/findAll', { type: CLOSET_TYPE, opt: { force: true } }).catch(() => {});
        cb(true);
        this.$router.push({ name: 'c-cluster-product-resource', params: this.doneParams });
      } catch (e) {
        clearPendingCloset(name);
        this.errors = [e.message];
        cb(false);
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
        <SidecarCard
          v-for="s in group.sidecars"
          :key="s.key"
          :name="s.name"
          :description="s.description"
          :params="s.params || []"
          :values="paramEdits[s.key]"
          :config-open="!!enabled[s.key]"
          :disabled="!enabled[s.key]"
        >
          <template #header-right>
            <Checkbox
              :value="!!enabled[s.key]"
              label="Enabled"
              @update:value="enabled[s.key] = $event"
            />
          </template>
        </SidecarCard>
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
</style>
