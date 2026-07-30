<script>
import { RcItemCard } from '@components/RcItemCard';
import { Checkbox } from '@components/Form/Checkbox';
import { LabeledInput } from '@components/Form/LabeledInput';
import LabeledSelect from '@shell/components/form/LabeledSelect';

// The one sidecar card, shared by the closet detail dashboard and the create
// page. It renders name + description + an editable Configuration accordion; the
// mode-specific bits — the status badge or enable toggle, launch links, action
// buttons, and any extra config — come in through slots.
export default {
  name: 'SidecarCard',

  components: {
    RcItemCard, Checkbox, LabeledInput, LabeledSelect,
  },

  props: {
    name:        { type: String, required: true },
    description: { type: String, default: '' },
    // Normalized params: { id, label, type: 'boolean'|'select'|'text', options?, taggable?, placeholder? }
    params:      { type: Array, default: () => [] },
    // Reactive value bag keyed by param id (mutated in place)
    values:      { type: Object, default: () => ({}) },
    unsupported: { type: String, default: '' },
    // start the Configuration accordion open
    configOpen:  { type: Boolean, default: false },
    // disable all config inputs (create: while the sidecar is off)
    disabled:    { type: Boolean, default: false },
  },

  computed: {
    hasConfig() {
      return this.params.length || !!this.$slots['config-extra'];
    },
  },
};
</script>

<template>
  <div class="sc-card">
    <rc-item-card
      :id="`sidecar-${name}`"
      :header="{}"
      variant="medium"
    >
    <template #item-card-header-title>
      <div class="title-row">
        <h3 class="item-card-header-title medium">
          {{ name }}
        </h3>
        <span class="header-right"><slot name="header-right" /></span>
      </div>
    </template>

    <template #item-card-sub-header>
      <div class="sub">
        <div v-if="description" class="desc">
          {{ description }}
        </div>
        <div class="links"><slot name="links" /></div>
        <span v-if="unsupported" class="unsupported">{{ unsupported }}</span>
      </div>
    </template>

    <template #item-card-footer>
      <div class="footer">
        <details v-if="hasConfig" class="config" :open="configOpen">
          <summary>Configuration</summary>
          <div class="config-body">
            <template v-for="p in params" :key="p.id">
              <Checkbox
                v-if="p.type === 'boolean'"
                :value="values[p.id] === 'true'"
                :label="p.label"
                :disabled="disabled"
                @update:value="values[p.id] = $event ? 'true' : ''"
              />
              <LabeledSelect
                v-else-if="p.type === 'select'"
                :label="p.label"
                :value="values[p.id]"
                :options="p.options || []"
                :taggable="!!p.taggable"
                :searchable="!!p.taggable"
                :disabled="disabled"
                @update:value="values[p.id] = typeof $event === 'object' ? ($event && $event.value) : $event"
              />
              <LabeledInput
                v-else
                v-model:value="values[p.id]"
                :label="p.label"
                :placeholder="p.placeholder || ''"
                :disabled="disabled"
              />
            </template>
            <slot name="config-extra" />
          </div>
        </details>
        <div class="actions"><slot name="actions" /></div>
      </div>
    </template>
    </rc-item-card>
  </div>
</template>

<style lang="scss" scoped>
.title-row {
  display: flex;
  align-items: center;
  width: 100%;

  h3 { margin: 0; }

  .header-right {
    margin-left: auto;
    display: flex;
    align-items: center;
  }
}

.sub {
  display: flex;
  flex-direction: column;
  gap: 6px;

  .desc { color: var(--input-label, var(--muted)); font-size: 13px; }

  .links {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;

    a { cursor: pointer; }
    &:empty { display: none; }
  }
}

.unsupported { font-style: italic; color: var(--muted); font-size: 12px; }

/* Fill the grid cell and force the RcItemCard's internal column to stretch, so
   the actions row can sit at the very bottom regardless of how much
   description/links/config sits above it. The wrapper is the element these
   :deep rules anchor from — a bare :deep(.item-card) wouldn't match the card
   (it's the child component's root, not a descendant of this scope). */
.sc-card {
  display: flex;
  height: 100%;
}
.sc-card :deep(.item-card) { flex: 1; align-items: stretch; }
.sc-card :deep(.item-card-body) { flex: 1; }
.sc-card :deep(.item-card-body-details) { display: flex; flex-direction: column; flex: 1; }

.footer {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  flex: 1 1 auto;
}

.config {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--border-radius, 4px);

  summary {
    padding: 4px 8px;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }

  &[open] > summary {
    color: var(--body-text);
    border-bottom: 1px solid var(--border);
  }

  .config-body {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto; /* pin to the bottom of the (stretched) footer */

  &:empty { display: none; }
}
</style>
