<script>
import { RcItemCard } from '@components/RcItemCard';
import { RcButton } from '@components/RcButton';
import { Checkbox } from '@components/Form/Checkbox';
import { LabeledInput } from '@components/Form/LabeledInput';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import { iconFor } from './sidecar-icons';

// The sidecar card used by the closet detail dashboard: name + description +
// status/links/actions via slots. Configuration lives behind a gear icon that
// opens a modal (teleported to <body>) so its dropdowns never overlap
// neighbouring cards the way an inline accordion did.
export default {
  name: 'SidecarCard',

  components: {
    RcItemCard, RcButton, Checkbox, LabeledInput, LabeledSelect,
  },

  props: {
    name:        { type: String, required: true },
    description: { type: String, default: '' },
    // Normalized params: { id, label, type: 'boolean'|'select'|'text', options?, taggable?, placeholder? }
    params:      { type: Array, default: () => [] },
    // Reactive value bag keyed by param id (mutated in place)
    values:      { type: Object, default: () => ({}) },
    unsupported: { type: String, default: '' },
    // Whether the config modal is open (v-model:config-open, parent-controlled
    // so the parent can also open it when Start needs configuration first).
    configOpen:  { type: Boolean, default: false },
    // Label for the modal's primary button (e.g. "Save & Restart" / "Start").
    saveLabel:   { type: String, default: 'Save' },
  },

  emits: ['update:configOpen', 'save'],

  computed: {
    hasConfig() {
      return this.params.length || !!this.$slots['config-extra'];
    },

    icon() {
      return iconFor(this.name);
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
      <template #item-card-image>
        <div class="sc-icon" :style="{ '--sc-color': icon.color }">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icon.path" /></svg>
        </div>
      </template>

      <template #item-card-header-title>
        <div class="title-row">
          <h3 class="item-card-header-title medium">
            {{ name }}
          </h3>
          <span class="right">
            <slot name="header-right" />
            <RcButton
              v-if="hasConfig"
              variant="ghost"
              size="small"
              class="gear"
              title="Configure"
              aria-label="Configure"
              @click="$emit('update:configOpen', true)"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" /></svg>
            </RcButton>
          </span>
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
          <div class="actions"><slot name="actions" /></div>
        </div>
      </template>
    </rc-item-card>

    <teleport to="body">
      <div
        v-if="configOpen"
        class="sc-modal-backdrop"
        @click.self="$emit('update:configOpen', false)"
      >
        <div class="sc-modal" role="dialog" aria-modal="true">
          <div class="sc-modal-header">
            <div class="mh-title">
              <span class="mh-icon" :style="{ '--sc-color': icon.color }">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="icon.path" /></svg>
              </span>
              <h3>Configure {{ name }}</h3>
            </div>
            <button type="button" class="mh-close" aria-label="Close" @click="$emit('update:configOpen', false)">✕</button>
          </div>

          <div class="sc-modal-body">
            <template v-for="p in params" :key="p.id">
              <Checkbox
                v-if="p.type === 'boolean'"
                :value="values[p.id] === 'true'"
                :label="p.label"
                @update:value="values[p.id] = $event ? 'true' : ''"
              />
              <LabeledSelect
                v-else-if="p.type === 'select'"
                :label="p.label"
                :value="values[p.id]"
                :options="p.options || []"
                :taggable="!!p.taggable"
                :searchable="!!p.taggable"
                :append-to-body="false"
                @update:value="values[p.id] = typeof $event === 'object' ? ($event && $event.value) : $event"
              />
              <LabeledInput
                v-else
                v-model:value="values[p.id]"
                :label="p.label"
                :placeholder="p.placeholder || ''"
              />
            </template>
            <slot name="config-extra" />
          </div>

          <div class="sc-modal-footer">
            <RcButton variant="secondary" @click="$emit('update:configOpen', false)">
              Cancel
            </RcButton>
            <RcButton variant="primary" @click="$emit('save')">
              {{ saveLabel }}
            </RcButton>
          </div>
        </div>
      </div>
    </teleport>
  </div>
</template>

<style lang="scss" scoped>
/* Brand icon tile in the card's left image column (like the chart-catalog
   cards). Fills RcItemCard's 48px image box, tinted with the brand color. */
.sc-icon {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--border-radius, 6px);
  background: color-mix(in srgb, var(--sc-color) 15%, transparent);

  svg {
    width: 26px;
    height: 26px;
    fill: var(--sc-color);
  }
}

.title-row {
  display: flex;
  align-items: center;
  width: 100%;

  h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  .right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* Ghost icon button — transparent, so no highlight box on hover, just a
     colour shift. */
  .gear {
    color: var(--muted);

    svg { width: 18px; height: 18px; fill: currentColor; display: block; }

    &:hover { color: var(--primary); }
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
   description/links sits above it. */
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

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto; /* pin to the bottom of the (stretched) footer */

  &:empty { display: none; }
}

/* ---- config modal (teleported to body) ---- */
/* Below vue-select's appended dropdown (--vs-dropdown-z-index: 1000) so the
   config selects' menus render above the modal, but above the page. */
.sc-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}

.sc-modal {
  width: 460px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  background: var(--modal-bg, var(--body-bg));
  border: 1px solid var(--border);
  border-radius: var(--border-radius, 6px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);

  .sc-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);

    .mh-title { display: flex; align-items: center; gap: 10px; }

    .mh-icon {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      background: color-mix(in srgb, var(--sc-color) 15%, transparent);
      svg { width: 18px; height: 18px; fill: var(--sc-color); }
    }

    h3 { margin: 0; font-size: 16px; font-weight: 600; }

    .mh-close {
      border: none;
      background: transparent;
      color: var(--muted);
      font-size: 16px;
      cursor: pointer;
      line-height: 1;
      &:hover { color: var(--body-text); }
    }
  }

  /* overflow visible (not auto) so a select's dropdown menu isn't clipped by
     the modal body — it renders over the footer via vue-select's z-index. */
  .sc-modal-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 14px;
    overflow: visible;

    .hint { margin: 0; color: var(--muted); font-size: 12px; }
  }

  .sc-modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }
}
</style>
