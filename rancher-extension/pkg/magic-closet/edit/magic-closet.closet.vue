<script>
import CruResource from '@shell/components/CruResource';
import NameNsDescription from '@shell/components/form/NameNsDescription';
import FormValidation from '@shell/mixins/form-validation';
import LabeledSelect from '@shell/components/form/LabeledSelect';
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

// Closets are created empty — every sidecar off. The user turns them on from
// the detail page.
const ALL_SIDECARS_OFF = {
  rancher: false, rancherBrowser: false, keycloak: false, openldap: false, figma: false,
};

// Create a closet: just a name + an optional secret set. Sidecars are all off
// to start and toggled on from the detail page.
export default {
  name: 'ClosetCreate',

  components: {
    CruResource, NameNsDescription, LabeledSelect,
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
      errors:         [],
      secretSets:     [],
      secretSetName:  '',
      fvFormRuleSets: [{ path: 'metadata.name', rules: ['required'] }],
    };
  },

  computed: {
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
        const secretValues = this.secretSetName ? await readSecretSet(this.secretSetName).catch(() => ({})) : {};

        for (const [id, env] of Object.entries(SECRET_PARAM_ENV)) {
          if (secretValues[id]) {
            config[env] = secretValues[id];
          }
        }

        // Install empty (all sidecars off), then show it and navigate.
        await createCloset(name, ALL_SIDECARS_OFF, config);
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
      tooltip="Credentials (tokens, keys) injected into the closet. Manage these under Secret Sets."
      :value="secretSetName"
      :options="secretSetOptions"
      :searchable="false"
      @update:value="secretSetName = typeof $event === 'object' ? ($event && $event.value) : $event"
    />
  </CruResource>
</template>

<style lang="scss" scoped>
.secret-set-select { margin: 20px 0; max-width: 480px; }
</style>
