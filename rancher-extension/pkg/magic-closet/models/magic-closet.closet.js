import Resource from '@shell/plugins/dashboard-store/resource-class';
import { deleteCloset } from '../api';

export default class Closet extends Resource {
  get canDelete() {
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
