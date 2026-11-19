import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 15173,
    proxy: {
      '/api': 'http://localhost:13000',
      '/docs': 'http://localhost:13000',
      '/openapi.json': 'http://localhost:13000',
      '/health': 'http://localhost:13000',
      '/ws': {
        target: 'ws://localhost:13000',
        ws: true,
      },
    },
  },
});
