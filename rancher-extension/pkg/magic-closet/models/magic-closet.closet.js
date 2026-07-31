import Resource from '@shell/plugins/dashboard-store/resource-class';
import { deleteCloset } from '../api';

export default class Closet extends Resource {
  // The config slide-in drawer defaults to a too-narrow 33% for spoofed
  // types (the shell's width prop isn't wired through), so disable it —
  // config editing uses the standard full-page editor instead.
  get disableResourceDetailDrawer() {
    return true;
  }

  get disableResourceDetailDrawerConfigTab() {
    return true;
  }

  get canDelete() {
    return true;
  }

  get canUpdate() {
    return false;
  }

  // The detail page is the interactive config UI — a closet has no separate
  // "Edit Config" page, so strip the edit/view/config/yaml/clone actions from
  // the ⋮ menu (they're enabled by the presence of the create component, which
  // we still need). Only Delete remains.
  get _availableActions() {
    const strip = ['goToEdit', 'goToViewConfig', 'showConfiguration', 'goToEditYaml', 'goToViewYaml', 'goToClone', 'cloneYaml'];

    return super._availableActions.filter((a) => !strip.includes(a.action));
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
