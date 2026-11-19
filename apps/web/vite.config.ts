import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxyTarget = process.env.VITE_API_PROXY || 'http://localhost:13000';
const wsTarget = proxyTarget.replace(/^http/i, 'ws');

export default defineConfig({
  plugins: [react()],
  server: {
    port: 15173,
    proxy: {
      '/api': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/docs': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/openapi.json': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/health': {
        target: proxyTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: wsTarget,
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
