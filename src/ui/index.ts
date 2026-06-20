/**
 * UI layer barrel — the runtime-bound Obsidian surfaces for Marginalia: the
 * right-sidebar aside panel and the settings tab. The plugin (`main.ts`) wires
 * these to the workspace and the {@link AnnotationStore}.
 */
export { ASIDE_VIEW_TYPE, MarginaliaAsideView } from './aside-view';
export type { AsideDeps } from './aside-view';

export { SelectionToolbar } from './selection-toolbar';
export type {
  SelectionToolbarDeps,
  HighlightRequest,
  ExistingHighlight,
} from './selection-toolbar';

export { MarginaliaSettingTab } from './settings-tab';
export type { SettingsHost } from './settings-tab';
