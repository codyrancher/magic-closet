<script>
import { LabeledInput } from '@components/Form/LabeledInput';
import { ToggleSwitch } from '@components/Form/ToggleSwitch';
import { RcButton } from '@components/RcButton';
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

  components: { LabeledInput, ToggleSwitch, RcButton },

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
      secretKeys: SECRET_KEYS,
      name:       this.value?.metadata?.name || '',
      isDefault:  !!this.value?.spec?.isDefault,
      values:     {},
      busy:       false,
      error:      null,
    };
  },

  computed: {
    isCreate() {
      return this.mode === 'create';
    },

    isView() {
      return this.mode === 'view';
    },
  },

  async created() {
    setCluster(this.$route.params.cluster);
    setSecretOwner(this.$store.getters['auth/principalId']);
    if (!this.isCreate && this.name) {
      this.values = await readSecretSet(this.name).catch(() => ({}));
    }
  },

  methods: {
    async save() {
      if (!this.name) {
        this.error = 'a name is required';

        return;
      }
      this.busy = true;
      this.error = null;
      try {
        await saveSecretSet(this.name, this.values, this.isDefault);
        this.done();
      } catch (e) {
        this.error = e.message;
        this.busy = false;
      }
    },

    done() {
      this.$router.push({
        name:   'c-cluster-product-resource',
        params: { cluster: this.$route.params.cluster, product: EXPLORER, resource: SECRET_SET_TYPE },
      });
    },
  },
};
</script>

<template>
  <div class="secret-set-edit">
    <div v-if="error" class="banner error">
      {{ error }}
    </div>

    <div class="form">
      <LabeledInput
        v-if="isCreate"
        v-model:value="name"
        label="Set name"
        placeholder="e.g. my-tokens"
      />
      <div class="default-row">
        <span>Default set</span>
        <ToggleSwitch v-model:value="isDefault" :disabled="isView" />
      </div>
      <LabeledInput
        v-for="k in secretKeys"
        :key="k.key"
        v-model:value="values[k.key]"
        type="password"
        :mode="mode"
        :label="k.label"
      />
    </div>

    <div v-if="!isView" class="actions">
      <rc-button variant="secondary" @click="done">
        Cancel
      </rc-button>
      <rc-button variant="primary" :disabled="busy" @click="save">
        {{ busy ? 'Saving…' : 'Save' }}
      </rc-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.secret-set-edit {
  .banner.error {
    border: 1px solid var(--error);
    border-radius: 4px;
    padding: 10px;
    margin-bottom: 15px;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
    max-width: 640px;

    .default-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      max-width: 640px;
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
