<script>
// Overrides the core /prefs route (registered in index.ts) so we can add an
// "Enable Magic Closet" checkbox to the end of the Advanced Features section
// WITHOUT copying the core template: render the original prefs page, then
// Teleport our checkbox into its `.adv-features` container once it's mounted.
import Prefs from '@shell/pages/prefs.vue';
import { Checkbox } from '@components/Form/Checkbox';
import { NAV_PREF } from '../product';

export default {
  name: 'MagicClosetPrefs',

  components: { Prefs, Checkbox },

  data() {
    return { ready: false };
  },

  computed: {
    enabled: {
      get() {
        try {
          return !!this.$store.getters['prefs/get'](NAV_PREF);
        } catch {
          return false;
        }
      },
      set(value) {
        this.$store.dispatch('prefs/set', { key: NAV_PREF, value: !!value });
      },
    },
  },

  mounted() {
    // Children mount before this hook, so the wrapped <Prefs/> has rendered and
    // `.adv-features` exists — now the Teleport can target it.
    this.ready = true;
  },
};
</script>

<template>
  <div class="magic-closet-prefs">
    <Prefs />
    <Teleport
      v-if="ready"
      to=".adv-features"
    >
      <Checkbox
        v-model:value="enabled"
        label="Enable Magic Closet"
        tooltip="Show the Magic Closet navigation (Closets, Secret Sets) in the cluster explorer."
        class="mt-20"
      />
    </Teleport>
  </div>
</template>
