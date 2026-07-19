<script>
import { closetApiBase, setCluster } from '../api';

export default {
  name: 'ClosetDetail',

  props: {
    value: {
      type:     Object,
      required: true,
    },
  },

  computed: {
    url() {
      setCluster(this.$route.params.cluster);

      // The closet's own dashboard, same-origin through the service proxy
      return `${ closetApiBase(this.value.spec.namespace) }/`;
    },
  },
};
</script>

<template>
  <div class="closet-detail">
    <iframe :src="url" class="dashboard" />
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
}
</style>
