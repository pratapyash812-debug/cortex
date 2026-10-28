import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, the Python server (port 8787) owns /api and /files.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: { '/api': 'http://127.0.0.1:8787', '/files': 'http://127.0.0.1:8787' },
  },
})
