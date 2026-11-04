import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The repo lives in OneDrive, where native file events are unreliable: poll instead.
  // /api goes to the live analysis server (`modulegraph --lazy --serve`), when one is running.
  server: { fs: { allow: ['..'] }, watch: { usePolling: true, interval: 300 }, proxy: { '/api': 'http://localhost:5174' } },
});
