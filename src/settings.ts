/**
 * Plugin settings — pure data only (interface + defaults), so any module can
 * import it without pulling in the Obsidian runtime. The settings *tab* (which
 * needs `obsidian`) lives separately in the UI layer.
 *
 * See Design.md §12 (settings: context length, fuzzy threshold, sidecar naming).
 */

/**
 * Built-in highlight color tokens (must match the `mrg-color-*` CSS classes and
 * `--mrg-*` theme variables). A stored color is either one of these tokens or an
 * arbitrary `#rrggbb` hex from the user's custom palette — see {@link './color'}.
 */
export const BUILTIN_COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'] as const;
export type BuiltinColor = (typeof BUILTIN_COLORS)[number];

/** A frontmatter key/value pair written into every newly created annotation file. */
export interface SidecarField {
  key: string;
  value: string;
}

export interface MarginaliaSettings {
  /** Inserted before the `.md` extension to name a source's sidecar, e.g. `.annotations`. */
  sidecarSuffix: string;
  /**
   * Vault folder under which new sidecars are created, mirroring the source's
   * path. Empty = store the sidecar alongside its source note (the default).
   */
  sidecarFolder: string;
  /** Color applied to a freshly created highlight (a built-in token or a `#hex`). */
  defaultColor: string;
  /** Ordered colors offered in the selection toolbar and card dropdown (tokens or `#hex`). */
  palette: string[];
  /** Minimum similarity (0–1) to accept a fuzzy re-anchor before orphaning (§6.2). */
  fuzzyThreshold: number;
  /** Characters of before/after context captured when creating a highlight (§5.4). */
  contextChars: number;
  /** Reveal the raw `anno` block when the cursor enters it in Live Preview (§7.1). */
  revealAnnoOnCursor: boolean;
  /** Open the aside panel automatically when a note with annotations is opened. */
  autoOpenAside: boolean;
  /** Vault folder holding Web Highlights JSON export(s); the newest by name is imported. */
  webHighlightsFolder: string;
  /** Folder to scan for clips when importing into all clips (empty = whole vault). */
  clipsFolder: string;
  /** Key/value pairs written into the frontmatter of every newly created annotation file. */
  sidecarFrontmatter: SidecarField[];
  /** Ask for confirmation before deleting an annotation (aside + toolbar). */
  confirmDelete: boolean;
}

export const DEFAULT_SETTINGS: MarginaliaSettings = {
  sidecarSuffix: '.annotations',
  sidecarFolder: '',
  defaultColor: 'yellow',
  palette: [...BUILTIN_COLORS],
  fuzzyThreshold: 0.7,
  contextChars: 30,
  revealAnnoOnCursor: true,
  autoOpenAside: false,
  webHighlightsFolder: '',
  clipsFolder: '',
  sidecarFrontmatter: [],
  confirmDelete: true,
};
