/**
 * Pure builders for links that point at an annotation's quote block inside its
 * sidecar. Every quote line carries an `^anno-<id>` block ref (see {@link annoRef}),
 * so an Obsidian subpath / wikilink can target it directly — which is what the
 * aside cards use to jump to, or copy a link to, an annotation in its file.
 *
 * No `obsidian` import: the *linktext* (a file → its shortest link form) is
 * computed by the caller at runtime via `metadataCache.fileToLinktext`; here we
 * only assemble the strings, so this stays pure and unit-tested.
 */
import { annoRef } from '@/model/types';

/** Block subpath for an annotation, e.g. `"#^anno-7c"` — appended to a linktext. */
export function annoBlockSubpath(id: string): string {
  return `#${annoRef(id)}`;
}

/**
 * Wikilink to an annotation's quote block: `[[<linktext>#^anno-<id>]]`. `linktext`
 * is the sidecar file's resolved link form (typically its basename).
 */
export function annoBlockWikilink(linktext: string, id: string): string {
  return `[[${linktext}${annoBlockSubpath(id)}]]`;
}
