import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';

// Init the package
export default function(plugin: IPlugin): void {
  // Auto-import model, detail, edit, list from the folders
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  // Closets live on the cluster explorer product (flat nav entry + generic
  // explorer routes)
  plugin.addProduct(require('./product'));

  // Override the core /prefs route with a wrapper that renders the original
  // page plus an "Enable Magic Closet" checkbox (see pages/prefs.vue). Same
  // name → replaces the built-in route.
  plugin.addRoute({
    name:      'prefs',
    path:      '/prefs',
    component: () => import('./pages/prefs.vue'),
  });
}
