<script>
import CruResource from '@shell/components/CruResource';
import FormValidation from '@shell/mixins/form-validation';
import { LabeledInput } from '@components/Form/LabeledInput';
import { Checkbox } from '@components/Form/Checkbox';
import {
  readSecretSet, saveSecretSet, setCluster, setSecretOwner,
} from '../api';
import { EXPLORER, SECRET_SET_TYPE } from '../product';
// Credential groups + per-sidecar usage are generated from the sidecar.yml
// declarations (workspace/sidecars/**) by scripts/gen-credentials.mjs — this
// page never hardcodes the key list, so adding a credential to a sidecar
// surfaces it here automatically.
import { CREDENTIAL_GROUPS } from '../credentials.generated';

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
      credentialGroups: CREDENTIAL_GROUPS,
      isDefault:        !!this.value?.spec?.isDefault,
      values:           {},
      errors:           [],
      fvFormRuleSets:   [{ path: 'metadata.name', rules: ['required'] }],
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
    // "figma: <usage>; rancher-browser: <usage>" — one clause per consuming sidecar
    usageText(field) {
      return (field.usages || []).map((u) => `${ u.sidecar }: ${ u.usage }`).join('; ');
    },

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

    <p class="text-muted mb-20">
      A secret set is a reusable bundle of tokens and keys. Leave a field blank to
      skip it. Each group below notes how the closet uses those values.
    </p>

    <div
      v-for="group in credentialGroups"
      :key="group.name"
      class="cred-group"
    >
      <h3 class="cred-group__title">
        {{ group.name }}
      </h3>
      <p
        v-if="group.description"
        class="text-muted cred-group__desc"
      >
        {{ group.description }}
      </p>

      <div class="row">
        <div
          v-for="field in group.fields"
          :key="field.key"
          class="col span-6 mb-10"
        >
          <LabeledInput
            v-model:value="values[field.key]"
            type="password"
            :mode="mode"
            :label="`${ field.label } (${ field.key })`"
          />
          <p
            v-if="usageText(field)"
            class="text-muted cred-usage"
          >
            {{ usageText(field) }}
          </p>
        </div>
      </div>
    </div>
  </CruResource>
</template>

<style lang="scss" scoped>
// Equal gap above (masthead divider) and below (default checkbox)
.name-input {
  margin: 20px 0;
}

.cred-group {
  margin-top: 24px;

  &__title {
    margin: 0 0 2px 0;
  }

  &__desc {
    margin: 0 0 12px 0;
  }
}

.cred-usage {
  margin: 4px 0 0 0;
  font-size: 12px;
}
</style>
