/**
 * Minimal stand-in for the `obsidian` module under vitest.
 *
 * The pure core (model, text, sidecar, resolver) must NOT depend on Obsidian.
 * This stub exists so that if a test accidentally pulls `obsidian` into the
 * graph it resolves to something importable, and so the few Obsidian-bound
 * helpers that take plain data can be unit-tested without the real runtime.
 *
 * It is intentionally incomplete — extend it as tests need specific symbols.
 */

export class Plugin {}
export class PluginSettingTab {}
export class ItemView {}
export class Component {}
export class Notice {
  constructor(public message: string) {}
}
export class TFile {
  path = '';
  basename = '';
  extension = 'md';
}
export class TFolder {
  path = '';
}
export abstract class TAbstractFile {
  path = '';
}
export class MarkdownView {}
export class WorkspaceLeaf {}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}

export const Platform = { isDesktop: true, isMobile: false };
