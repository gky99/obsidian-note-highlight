/**
 * The anchor resolver — Marginalia's re-anchoring engine ("the spine", §13).
 *
 * Public surface:
 *  - {@link resolve}: re-resolve an annotation's selectors against current
 *    source bytes, returning a live range or an honest orphan (§6.2, §6.3).
 *  - {@link SourceStructure}: the Obsidian-agnostic scope provider the resolver
 *    narrows its search with; {@link inMemoryStructure} builds one from explicit
 *    regions (tests, or any caller that already knows offsets).
 *  - {@link ResolveResult} / {@link ResolveOptions}: result and tuning types.
 */
export { resolve } from './resolve';
export type { ResolveResult, ResolveOptions, ResolveMethod } from './resolve';
export type { SourceStructure, InMemoryStructureSpec } from './structure';
export { inMemoryStructure } from './structure';
