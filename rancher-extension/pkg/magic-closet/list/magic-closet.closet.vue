<script>
import Masthead from '@shell/components/ResourceList/Masthead';
import ResourceTable from '@shell/components/ResourceTable';
import { RcButton } from '@components/RcButton';
import { CLOSET_TYPE, EXPLORER, SECRET_SET_TYPE } from '../product';

// Custom list page so we can add a "Configure Secrets" action next to Create.
export default {
  name: 'ClosetList',

  components: { Masthead, ResourceTable, RcButton },

  props: {
    schema: {
      type:    Object,
      default: () => ({}),
    },
  },

  data() {
    return { rows: [] };
  },

  async fetch() {
    this.rows = await this.$store.dispatch('cluster/findAll', { type: CLOSET_TYPE });
  },

  methods: {
    configureSecrets() {
      this.$router.push({
        name:   'c-cluster-product-resource',
        params: { cluster: this.$route.params.cluster, product: EXPLORER, resource: SECRET_SET_TYPE },
      });
    },
  },
};
</script>

<template>
  <div>
    <Masthead
      :schema="schema"
      :resource="CLOSET_TYPE"
      :is-creatable="true"
    >
      <template #extraActions>
        <rc-button variant="secondary" @click="configureSecrets">
          Configure Secrets
        </rc-button>
      </template>
    </Masthead>

    <ResourceTable
      :schema="schema"
      :rows="rows"
      :headers="$store.getters['type-map/headersFor'](schema)"
    />
  </div>
</template>
