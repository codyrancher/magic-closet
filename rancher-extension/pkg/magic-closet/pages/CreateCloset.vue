<script>
import { apiFetch, resolveApiUrl } from '../api';

export default {
  name: 'CreateCloset',

  data() {
    return { name: '', busy: false, error: null };
  },

  async created() {
    await resolveApiUrl();
  },

  methods: {
    async create() {
      this.busy = true;
      this.error = null;
      try {
        await apiFetch('/closets', { method: 'POST', body: JSON.stringify({ name: this.name }) });
        this.$router.push({ name: 'c-cluster-magicCloset', params: { cluster: this.$route.params.cluster } });
      } catch (e) {
        this.error = e.message;
        this.busy = false;
      }
    },
  },
};
</script>

<template>
  <div class="closet-create">
    <h1>Create Closet</h1>
    <p class="hint">
      Provisions a new magic-closet instance on the controller host — its own
      port block, sidecars, workspace, and generated credentials. The closet
      appears in the list while it provisions.
    </p>

    <div v-if="error" class="banner error">{{ error }}</div>

    <div class="form">
      <label>Name</label>
      <input v-model="name" placeholder="e.g. pr-18387" @keyup.enter="create" />
    </div>

    <div class="actions">
      <button class="btn role-secondary" @click="$router.back()">Cancel</button>
      <button class="btn role-primary" :disabled="!name || busy" @click="create">
        {{ busy ? 'Creating…' : 'Create' }}
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.closet-create {
  padding: 20px;
  max-width: 560px;

  .hint {
    opacity: 0.8;
    margin: 10px 0 20px;
  }

  .banner.error {
    border: 1px solid var(--error);
    border-radius: 4px;
    padding: 10px;
    margin-bottom: 15px;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 20px;

    label {
      opacity: 0.8;
      font-size: 13px;
    }
  }

  .actions {
    display: flex;
    gap: 10px;
    justify-content: flex-end;
  }
}
</style>
