import { defineConfig } from 'vite';

// base: './' keeps asset paths relative so the built game runs from any
// subfolder (e.g. GitHub Pages project sites) or straight off the filesystem.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split the long-lived three.js vendor chunk from app code so editing
        // game code doesn't invalidate the cached engine payload on repeat visits.
        manualChunks: { three: ['three'] },
      },
    },
  },
  server: {
    host: true,
    open: true,
  },
});
