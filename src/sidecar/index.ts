/**
 * Sidecar file I/O — parse and serialize the per-source annotation `.md` file
 * (Design.md §5). Round-trips losslessly: `parseSidecar(serializeSidecar(s))`
 * deep-equals `s`.
 */
export { parseSidecar, parseLayout, type ParseIssue, type SidecarLayout, type UnitLayout } from './parse';
export { serializeSidecar } from './serialize';
export { patchSidecar } from './patch';
export { sortHighlights } from './sort';
export { SidecarError, SidecarParseError, SidecarSchemaError } from './errors';

// Re-export the schema constant so callers can gate without reaching into the
// model package directly.
export { SCHEMA_VERSION } from '@/model/types';
