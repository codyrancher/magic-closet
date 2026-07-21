<script>
import { RcButton } from '@components/RcButton';
import { RcSection } from '@components/RcSection';
import RcIcon from '@components/RcIcon/RcIcon.vue';
import { LabeledInput } from '@components/Form/LabeledInput';
import { ToggleSwitch } from '@components/Form/ToggleSwitch';
import {
  deleteSecretSet, listSecretSets, readSecretSet, saveSecretSet, setCluster, setSecretOwner,
} from '../api';
import { EXPLORER, CLOSET_TYPE } from '../product';

// The known secret keys a set can hold (param id -> friendly label). Kept in
// sync with the secret-style params across sidecars.
const SECRET_KEYS = [
  { key: 'ghToken', label: 'GitHub token (ghToken)' },
  { key: 'appcoToken', label: 'AppCo token (appcoToken)' },
  { key: 'awsAccessKey', label: 'AWS access key (awsAccessKey)' },
  { key: 'awsSecretKey', label: 'AWS secret key (awsSecretKey)' },
  { key: 'apiKey', label: 'Figma API key (apiKey)' },
];

export default {
  name: 'ConfigureSecrets',

  components: {
    RcButton, RcSection, RcIcon, LabeledInput, ToggleSwitch,
  },

  data() {
    return {
      secretKeys: SECRET_KEYS,
      sets:       [],
      loaded:     false,
      error:      null,
      // editing state
      editing:    null, // display name being edited, or '' for a new set
      form:       { name: '', isDefault: false, values: {} },
      busy:       false,
    };
  },

  created() {
    setCluster(this.$route.params.cluster);
    setSecretOwner(this.$store.getters['auth/principalId']);
    this.load();
  },

  methods: {
    async load() {
      try {
        this.sets = await listSecretSets();
        this.error = null;
      } catch (e) {
        this.error = e.message;
      }
      this.loaded = true;
    },

    newSet() {
      this.editing = '';
      this.form = { name: '', isDefault: this.sets.length === 0, values: {} };
    },

    async edit(set) {
      this.editing = set.name;
      const values = await readSecretSet(set.name).catch(() => ({}));

      this.form = { name: set.name, isDefault: set.isDefault, values: { ...values } };
    },

    async save() {
      if (!this.form.name) {
        this.error = 'a name is required';

        return;
      }
      this.busy = true;
      this.error = null;
      try {
        await saveSecretSet(this.form.name, this.form.values, this.form.isDefault);
        this.editing = null;
        await this.load();
      } catch (e) {
        this.error = e.message;
      }
      this.busy = false;
    },

    async remove(set) {
      this.busy = true;
      try {
        await deleteSecretSet(set.name);
        await this.load();
      } catch (e) {
        this.error = e.message;
      }
      this.busy = false;
    },

    backToClosets() {
      this.$router.push({
        name:   'c-cluster-product-resource',
        params: { cluster: this.$route.params.cluster, product: EXPLORER, resource: CLOSET_TYPE },
      });
    },
  },
};
</script>

<template>
  <div class="configure-secrets">
    <div class="masthead">
      <h1>Configure Secrets</h1>
      <rc-button variant="secondary" @click="backToClosets">
        Back to Magic Closets
      </rc-button>
    </div>
    <p class="hint">
      Secret sets are reusable bundles of tokens/keys, scoped to your Rancher
      user. Pick one when creating a closet; its values fill the matching
      secret params. One set can be the default.
    </p>

    <div v-if="error" class="banner error">
      {{ error }}
    </div>

    <!-- Editing / creating a set -->
    <RcSection
      v-if="editing !== null"
      :title="editing ? `Edit set: ${editing}` : 'New secret set'"
      type="primary"
      mode="with-header"
      class="section"
    >
      <div class="form">
        <LabeledInput
          v-if="editing === ''"
          v-model:value="form.name"
          label="Set name"
          placeholder="e.g. my-tokens"
        />
        <div class="default-row">
          <span>Default set</span>
          <ToggleSwitch v-model:value="form.isDefault" />
        </div>
        <LabeledInput
          v-for="k in secretKeys"
          :key="k.key"
          v-model:value="form.values[k.key]"
          type="password"
          :label="k.label"
        />
        <div class="actions">
          <rc-button variant="secondary" @click="editing = null">
            Cancel
          </rc-button>
          <rc-button variant="primary" :disabled="busy" @click="save">
            {{ busy ? 'Saving…' : 'Save' }}
          </rc-button>
        </div>
      </div>
    </RcSection>

    <!-- List of sets -->
    <RcSection
      v-else
      title="Secret sets"
      type="primary"
      mode="with-header"
      class="section"
    >
      <rc-button variant="primary" class="add-btn" @click="newSet">
        Add secret set
      </rc-button>
      <div v-if="loaded && !sets.length" class="empty">
        No secret sets yet.
      </div>
      <table v-else-if="sets.length" class="sets">
        <thead>
          <tr>
            <th>Name</th>
            <th>Default</th>
            <th>Keys</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="set in sets" :key="set.name">
            <td>{{ set.name }}</td>
            <td>{{ set.isDefault ? 'default' : '' }}</td>
            <td>{{ set.keys.join(', ') || '—' }}</td>
            <td class="row-actions">
              <rc-button variant="ghost" size="small" @click="edit(set)">
                Edit
              </rc-button>
              <rc-button variant="ghost" size="small" :disabled="busy" @click="remove(set)">
                <rc-icon type="trash" status="error" />
              </rc-button>
            </td>
          </tr>
        </tbody>
      </table>
    </RcSection>
  </div>
</template>

<style lang="scss" scoped>
.configure-secrets {
  padding: 10px 0 40px 0;

  .masthead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;

    h1 {
      margin: 0;
    }
  }

  .hint {
    opacity: 0.8;
    margin-bottom: 16px;
    max-width: 720px;
  }

  .banner.error {
    border: 1px solid var(--error);
    border-radius: 4px;
    padding: 10px;
    margin-bottom: 15px;
  }

  .section {
    margin-top: 12px;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 520px;

    .default-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .actions {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      margin-top: 8px;
    }
  }

  .add-btn {
    margin-bottom: 12px;
  }

  .empty {
    opacity: 0.7;
  }

  table.sets {
    width: 100%;
    border-collapse: collapse;

    th, td {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
    }

    .row-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
  }
}
</style>
