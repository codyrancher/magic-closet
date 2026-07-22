<script>
import CruResource from '@shell/components/CruResource';
import FormValidation from '@shell/mixins/form-validation';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Checkbox } from '@components/Form/Checkbox';
import {
  readSecretSet, saveSecretSet, setCluster, setSecretOwner,
} from '../api';
import { EXPLORER, SECRET_SET_TYPE } from '../product';

// The known secret keys a set can hold, laid out in rows: related credentials
// (AppCo, AWS, Azure) share a line; each field is half width.
const SECRET_GROUPS = [
  [
    { key: 'ghToken', label: 'GitHub token (ghToken)' },
    { key: 'apiKey', label: 'Figma API key (apiKey)' },
  ],
  [
    { key: 'appcoEmail', label: 'AppCo email (appcoEmail)' },
    { key: 'appcoToken', label: 'AppCo token (appcoToken)' },
  ],
  [
    { key: 'awsAccessKey', label: 'AWS access key (awsAccessKey)' },
    { key: 'awsSecretKey', label: 'AWS secret key (awsSecretKey)' },
  ],
  [
    { key: 'gcpServiceAccountKey', label: 'GCP service account key (gcpServiceAccountKey)' },
  ],
  [
    { key: 'azureClientId', label: 'Azure client ID (azureClientId)' },
    { key: 'azureClientSecret', label: 'Azure client secret (azureClientSecret)' },
  ],
  [
    { key: 'azureSubscriptionId', label: 'Azure subscription ID (azureSubscriptionId)' },
    { key: 'azureTenantId', label: 'Azure tenant ID (azureTenantId)' },
  ],
];

export default {
  name: 'SecretSetEdit',

  components: {
    CruResource, LabeledInput, Checkbox,
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
    // The shared FormValidation mixin validates paths within `this.value`
    if (!this.value.metadata) {
      this.value.metadata = { name: this.value.id || '' };
    }

    return {
      secretGroups:   SECRET_GROUPS,
      isDefault:      !!this.value?.spec?.isDefault,
      values:         {},
      errors:         [],
      fvFormRuleSets: [{ path: 'metadata.name', rules: ['required'] }],
    };
  },

  computed: {
    isCreate() {
      return this.mode === 'create';
    },

    doneRoute() {
      return 'c-cluster-product-resource';
    },

    doneParams() {
      return { cluster: this.$route.params.cluster, product: EXPLORER, resource: SECRET_SET_TYPE };
    },
  },

  async created() {
    setCluster(this.$route.params.cluster);
    setSecretOwner(this.$store.getters['auth/principalId']);
    if (!this.isCreate && this.value?.metadata?.name) {
      this.values = await readSecretSet(this.value.metadata.name).catch(() => ({}));
    }
  },

  methods: {
    async save(saveCb) {
      this.errors = [];
      try {
        await saveSecretSet(this.value.metadata.name, this.values, this.isDefault);
        saveCb(true);
        this.$router.push({ name: this.doneRoute, params: this.doneParams });
      } catch (e) {
        this.errors = [e.message];
        saveCb(false);
      }
    },

    cancel() {
      this.$router.push({ name: this.doneRoute, params: this.doneParams });
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
    :done-route="doneRoute"
    @finish="save"
    @cancel="cancel"
    @error="e => errors = e"
  >
    <LabeledInput
      v-model:value="value.metadata.name"
      class="name-input"
      :mode="mode"
      label="Set name"
      required
      :rules="fvGetAndReportPathRules('metadata.name')"
    />

    <Checkbox
      v-model:value="isDefault"
      class="mb-20"
      label="Default set"
      :disabled="mode === 'view'"
    />

    <div
      v-for="(group, gi) in secretGroups"
      :key="gi"
      class="row mb-10"
    >
      <div
        v-for="k in group"
        :key="k.key"
        class="col span-6"
      >
        <LabeledInput
          v-model:value="values[k.key]"
          type="password"
          :mode="mode"
          :label="k.label"
        />
      </div>
    </div>
  </CruResource>
</template>

<style lang="scss" scoped>
// Equal gap above (masthead divider) and below (default checkbox)
.name-input {
  margin: 20px 0;
}
</style>
