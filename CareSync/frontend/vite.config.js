import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['pwa-icon.svg'],
      manifest: {
        name: 'CareSync Rural Health Kiosk',
        short_name: 'CareSync',
        description: 'Offline-first AI triage and care-navigation dashboard for ration-shop operators.',
        theme_color: '#0f766e',
        background_color: '#f8fafc',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: 'pwa-icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,json}'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/facilities'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'caresync-facilities-cache',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 60 * 60 * 24,
              },
            },
          },
        ],
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/reminders': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/admin': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/triage': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/facilities': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/visits': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/twiml': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});

