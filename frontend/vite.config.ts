import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  envDir: '..',
  server: { proxy: { '/api': 'http://localhost:8080' } },
})
