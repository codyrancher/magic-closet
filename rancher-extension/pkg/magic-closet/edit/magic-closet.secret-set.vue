<script>
import CruResource from '@shell/components/CruResource';
import NameNsDescription from '@shell/components/form/NameNsDescription';
import FormValidation from '@shell/mixins/form-validation';
import { LabeledInput } from '@components/Form/LabeledInput';
import { ToggleSwitch } from '@components/Form/ToggleSwitch';
import {
  readSecretSet, saveSecretSet, setCluster, setSecretOwner,
} from '../api';
import { EXPLORER, SECRET_SET_TYPE } from '../product';

// The known secret keys a set can hold (param id -> friendly label)
const SECRET_KEYS = [
  { key: 'ghToken', label: 'GitHub token (ghToken)' },
  { key: 'appcoToken', label: 'AppCo token (appcoToken)' },
  { key: 'awsAccessKey', label: 'AWS access key (awsAccessKey)' },
  { key: 'awsSecretKey', label: 'AWS secret key (awsSecretKey)' },
  { key: 'apiKey', label: 'Figma API key (apiKey)' },
];

export default {
  name: 'SecretSetEdit',

  components: {
    CruResource, NameNsDescription, LabeledInput, ToggleSwitch,
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
      secretKeys:      SECRET_KEYS,
      isDefault:       !!this.value?.spec?.isDefault,
      values:          {},
      errors:          [],
      fvFormRuleSets:  [{ path: 'metadata.name', rules: ['required'] }],
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
    :validation-passed="fvFormIsValid"
    :errors="errors"
    :cancel-event="true"
    :done-route="doneRoute"
    @finish="save"
    @cancel="cancel"
    @error="e => errors = e"
  >
    <NameNsDescription
      :value="value"
      :mode="mode"
      :namespaced="false"
      :description-hidden="true"
      name-label="Set name"
      :rules="{ name: fvGetAndReportPathRules('metadata.name') }"
    />

    <div class="default-row">
      <span>Default set</span>
      <ToggleSwitch v-model:value="isDefault" :disabled="mode === 'view'" />
    </div>

    <LabeledInput
      v-for="k in secretKeys"
      :key="k.key"
      v-model:value="values[k.key]"
      class="mb-10"
      type="password"
      :mode="mode"
      :label="k.label"
    />
  </CruResource>
</template>

<style lang="scss" scoped>
.default-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  max-width: 640px;
  margin: 10px 0 20px 0;
}
</style>
