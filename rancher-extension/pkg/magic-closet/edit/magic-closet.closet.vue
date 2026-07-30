<script>
import CruResource from '@shell/components/CruResource';
import NameNsDescription from '@shell/components/form/NameNsDescription';
import FormValidation from '@shell/mixins/form-validation';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { RcItemCard } from '@components/RcItemCard';
import { RcSection } from '@components/RcSection';
import { Checkbox } from '@components/Form/Checkbox';
import {
  createCloset, listSecretSets, readSecretSet, setCluster, setSecretOwner,
} from '../api';
import { EXPLORER, CLOSET_TYPE } from '../product';

// Secret-style key -> chart config env var, for injecting the chosen secret
// set's values at create time
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

// The fixed set of sidecars a closet can run (there's no closet api to query
// yet at create time). Rendered as the same cards as the detail view, each with
// an enable toggle instead of Start/Stop.
const SIDECAR_CATALOG = [
  { key: 'vscode', name: 'vscode', group: 'Dev', description: 'VS Code editing /workspace.' },
  { key: 'rancher', name: 'rancher', group: 'Dev', description: 'Rancher server. First start ~10 min.' },
  { key: 'rancherBrowser', name: 'rancher-browser', group: 'Dev', description: 'Chromium with Rancher quick-login.' },
  { key: 'keycloak', name: 'keycloak', group: 'Auth', description: 'Keycloak OIDC/SAML provider.' },
  { key: 'openldap', name: 'openldap', group: 'Auth', description: 'OpenLDAP directory server.' },
  { key: 'figma', name: 'figma', group: 'Design', description: 'Figma MCP server.' },
];

// Create a closet: pick a name + secret set, then toggle which sidecars start.
export default {
  name: 'ClosetCreate',

  components: {
    CruResource, NameNsDescription, LabeledSelect, RcItemCard, RcSection, Checkbox,
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

    return {
      errors:        [],
      enabled:       {
        vscode: false, rancher: true, rancherBrowser: false, keycloak: true, openldap: false, figma: false,
      },
      secretSets:    [],
      secretSetName: '',
      fvFormRuleSets: [{ path: 'metadata.name', rules: ['required'] }],
    };
  },

  computed: {
    groups() {
      const names = [...new Set(SIDECAR_CATALOG.map((s) => s.group))];

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
        const secretValues = this.secretSetName ? await readSecretSet(this.secretSetName).catch(() => ({})) : {};
        const config = {};

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

    // The helm app record lags a few seconds; force-refetch until the closet
    // shows so the list updates without a reload.
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
</style>
