/**
 * Thin wrappers over `js-yaml` tuned for sidecar I/O.
 *
 * Two non-negotiables (Design.md §4.4, §5.4):
 *  - `lineWidth: -1` on dump so long `before`/`after` context strings are NEVER
 *    wrapped/reflowed — wrapping would corrupt the anchor data.
 *  - the `anno` record's keys are emitted in a stable, readable canonical order
 *    so round-trips are byte-stable and the file reads well by hand.
 */
import yaml from 'js-yaml';

import type { AnnoRecord, SidecarFrontmatter } from '@/model/types';

/** Canonical key order for an `anno` record; unknown keys trail, in insertion order. */
const ANNO_KEY_ORDER: readonly string[] = [
  'id',
  'pin',
  'heading',
  'before',
  'after',
  'qhash',
  'status',
  'color',
  'created',
  'comment',
];

/** Canonical key order for frontmatter; unknown keys trail, in insertion order. */
const FRONTMATTER_KEY_ORDER: readonly string[] = [
  'schema',
  'annotates',
  'source_url',
  'clipped',
  'source_hash',
];

/**
 * Reorder an object's keys so the known ones lead in `order` and any remaining
 * keys follow in their original insertion order. `undefined` values are dropped
 * (js-yaml would otherwise emit `key: null` / `key: undefined`).
 */
function orderKeys<T extends Record<string, unknown>>(
  obj: T,
  order: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (key in obj && obj[key] !== undefined) out[key] = obj[key];
  }
  for (const key of Object.keys(obj)) {
    if (!order.includes(key) && obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

// CORE_SCHEMA (YAML 1.1 core) deliberately omits the implicit *timestamp* type:
// `created: 2026-06-19T10:32:00Z` and `clipped: 2026-06-19` stay STRINGS rather
// than becoming JS `Date`s, which would re-serialize differently and silently
// corrupt the anchor record on round-trip. Numbers/booleans still parse natively.
const SCHEMA = yaml.CORE_SCHEMA;
const DUMP_OPTS: yaml.DumpOptions = { lineWidth: -1, noRefs: true, schema: SCHEMA };
const LOAD_OPTS: yaml.LoadOptions = { schema: SCHEMA };

/** Parse a YAML document, returning a plain object (or `{}` for empty input). */
export function loadYaml(text: string): Record<string, unknown> {
  const value = yaml.load(text, LOAD_OPTS);
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Expected a YAML mapping at the top level.');
  }
  return value as Record<string, unknown>;
}

/** Dump frontmatter in canonical order; no trailing newline beyond YAML's own. */
export function dumpFrontmatter(fm: SidecarFrontmatter): string {
  return yaml.dump(orderKeys(fm, FRONTMATTER_KEY_ORDER), DUMP_OPTS);
}

/** Dump an `anno` record in canonical order with context strings never wrapped. */
export function dumpAnnoRecord(record: AnnoRecord): string {
  return yaml.dump(orderKeys(record, ANNO_KEY_ORDER), DUMP_OPTS);
}
