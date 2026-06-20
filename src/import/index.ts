/**
 * Import layer barrel — bringing Web Highlights exports into Marginalia as
 * sidecar annotations. The pure pieces (`web-highlights`, `plan`) parse and match;
 * the runtime {@link WebHighlightsImporter} wires them to the vault + store.
 */
export { WebHighlightsImporter } from './importer';
export { planImport, type ImportPlan, type PlannedHighlight } from './plan';
export {
  parseExport,
  marksForUrl,
  urlFromMeta,
  urlsWithMarks,
  normalizeUrl,
  markColor,
  markComment,
  htmlToMarkdown,
  colorsInExport,
  type Mark,
  type WebHighlightsExport,
} from './web-highlights';
