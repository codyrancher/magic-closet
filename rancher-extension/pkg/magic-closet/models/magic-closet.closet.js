import Resource from '@shell/plugins/dashboard-store/resource-class';
import { deleteCloset } from '../api';

export default class Closet extends Resource {
  // Force the standard 73% / full-height slide-in. Some bundled resource-class
  // versions omit the width prop, which makes the panel default to 33%.
  showConfiguration(returnFocusSelector, defaultTab) {
    const onClose = () => this.$ctx.commit('slideInPanel/close', undefined, { root: true });

    this.$ctx.commit('slideInPanel/open', {
      component:      require('@shell/components/Drawer/ResourceDetailDrawer/index.vue').default,
      componentProps: {
        resource:           this,
        onClose,
        width:              '73%',
        height:             '100vh',
        top:                '0',
        'z-index':          101,
        closeOnRouteChange: ['name', 'params', 'query'],
        triggerFocusTrap:   true,
        returnFocusSelector,
        defaultTab,
      },
    }, { root: true });
  }

  get canDelete() {
    return true;
  }

  get canUpdate() {
    return true;
  }

  get canClone() {
    return false;
  }

  get canYaml() {
    return false;
  }

  get canViewInApi() {
    return false;
  }

  async remove() {
    await deleteCloset(this.spec);

    // The helm app record lingers briefly after uninstall — force-refetch
    // until it's gone so the row disappears without a page reload
    for (let i = 0; i < 15; i++) {
      const all = await this.$dispatch('findAll', { type: this.type, opt: { force: true } });

      if (!(all || []).some((c) => c.metadata?.name === this.metadata?.name)) {
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
