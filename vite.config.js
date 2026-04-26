import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: '/zen-garden/',
  build: {
    rollupOptions: {
      input: {
        main:     resolve(__dirname, 'index.html'),
        gpuSpike: resolve(__dirname, 'gpu-spike.html'),
      },
    },
  },
});
