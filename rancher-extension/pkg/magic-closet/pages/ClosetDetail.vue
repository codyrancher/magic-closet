<script>
import { apiFetch, closetUrl, getApiUrl, resolveApiUrl } from '../api';

export default {
  name: 'ClosetDetail',

  data() {
    return { url: null, error: null };
  },

  async created() {
    await resolveApiUrl();
    const name = this.$route.params.closet;

    try {
      const data = await apiFetch('/closets');
      const gateway = data.hostGateway || null;
      const closet = (data.closets || []).find((c) => c.name === name);

      if (!closet) {
        this.error = `Unknown closet: ${ name }`;
      } else {
        // Every closet's api serves its dashboard; the controller's own url
        // for the local closet, host:apiPort for provisioned ones
        this.url = closet.local ? getApiUrl() : closetUrl(closet, gateway);
      }
    } catch (e) {
      this.error = e.message;
    }
  },
};
</script>

<template>
  <div class="closet-detail">
    <div v-if="error" class="banner error">{{ error }}</div>
    <iframe v-else-if="url" :src="url" class="dashboard" />
  </div>
</template>

<style lang="scss" scoped>
.closet-detail {
  position: absolute;
  inset: 0;
  display: flex;

  .dashboard {
    flex: 1;
    border: 0;
    width: 100%;
    height: 100%;
  }

  .banner.error {
    margin: 20px;
    border: 1px solid var(--error);
    border-radius: 4px;
    padding: 10px;
  }
}
</style>
