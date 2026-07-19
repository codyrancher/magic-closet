<script>
import { closetApiBase, listClosets, setCluster } from '../api';

export default {
  name: 'ClosetDetail',

  data() {
    return { url: null, error: null };
  },

  async created() {
    setCluster(this.$route.params.cluster);
    const name = this.$route.params.closet;

    try {
      const closets = await listClosets();
      const closet = closets.find((c) => c.name === name);

      if (!closet) {
        this.error = `Unknown closet: ${ name }`;
      } else {
        // The closet's dashboard, same-origin through Rancher's service proxy
        this.url = `${ closetApiBase(closet.namespace) }/`;
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
