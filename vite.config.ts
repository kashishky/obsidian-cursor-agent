import { defineConfig } from 'vite';
import copy from 'rollup-plugin-copy';

export default defineConfig({
  build: {
    target: 'es2020',
    lib: {
      entry: 'src/main.ts',
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      external: ['obsidian', 'electron', 'fs', 'path', 'os', 'child_process'],
      plugins: [
        copy({
          targets: [
            { src: 'manifest.json', dest: 'dist' },
            { src: 'styles.css', dest: 'dist' }
          ]
        })
      ]
    },
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false
  }
});
