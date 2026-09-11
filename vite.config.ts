import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // The bundle is almost entirely the two bundled JSON files, and the
        // provider data is rewritten by the daily update workflow. Splitting
        // them apart means that daily commit only invalidates the small
        // providers chunk, leaving the much larger benchmarks chunk and the
        // vendor chunk cached in browsers that already have them.
        manualChunks(id) {
          if (id.includes('data/benchmarks.json')) return 'data-benchmarks'
          if (id.includes('data/providers.json')) return 'data-providers'
          if (id.includes('node_modules')) return 'vendor'
        },
      },
    },
    // The benchmarks chunk is a data blob, not shippable code, so the default
    // 500 kB advisory fires on every build with nothing actionable behind it.
    // Raised to sit above the data chunks but still catch app-code bloat.
    chunkSizeWarningLimit: 2500,
  },
})
