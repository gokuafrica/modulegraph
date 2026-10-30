import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The repo lives in OneDrive, where native file events are unreliable: poll instead.
  server: { fs: { allow: ['..'] }, watch: { usePolling: true, interval: 300 } },
});
