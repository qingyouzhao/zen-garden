import { defineConfig } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: '/zen-garden/',
  build: {
    rollupOptions: {
      input: {
        main:           resolve(__dirname, 'index.html'),
        classic:        resolve(__dirname, 'classic.html'),
        gpu:            resolve(__dirname, 'gpu.html'),
        gpuParticle:    resolve(__dirname, 'gpu-particle.html'),
        sandApproach1:  resolve(__dirname, 'sand-approach-1.html'),
        sandApproach2:  resolve(__dirname, 'sand-approach-2.html'),
        sandApproach3:  resolve(__dirname, 'sand-approach-3.html'),
      },
    },
  },
});
