import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = resolve(root, '../..');

export default defineConfig({
  root,
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src'),
      '@shared': resolve(projectRoot, 'shared'),
    },
  },
  server: {
    fs: { allow: [projectRoot] },
  },
});
