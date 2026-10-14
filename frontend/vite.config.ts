import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  envDir: '..',
  // API_URL=http://localhost:8090 npm run dev, when something else already holds 8080
  server: { proxy: { '/api': process.env.API_URL ?? 'http://localhost:8080' } },
})
