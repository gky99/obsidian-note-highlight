import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import builtins from 'builtin-modules';

// Obsidian provides these at runtime; bundling our own copy breaks the editor
// (see Design.md §9). Everything here must be marked `external`.
const OBSIDIAN_PROVIDED = [
  'obsidian',
  'electron',
  '@codemirror/autocomplete',
  '@codemirror/collab',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lint',
  '@codemirror/search',
  '@codemirror/state',
  '@codemirror/view',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
];

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    // Emit a single CommonJS `main.js` at the vault-plugin root, as Obsidian expects.
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: [...OBSIDIAN_PROVIDED, ...builtins],
      output: {
        // A plugin must `module.exports =` its default Plugin subclass.
        exports: 'default',
        assetFileNames: 'styles.css',
      },
    },
    outDir: '.',
    emptyOutDir: false,
    // External `.map` file keeps `main.js` lean for release; the map is gitignored.
    sourcemap: true,
    target: 'es2018',
    minify: false,
    cssCodeSplit: false,
  },
});
