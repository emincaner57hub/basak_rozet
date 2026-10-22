import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Sunucudaki sürümle karşılaştırıp "yeni sürüm var" uyarısı göstermek için
  define: { __BUILD_VERSION__: JSON.stringify((process.env.RENDER_GIT_COMMIT ?? '').slice(0, 7) || 'yerel') },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3001' },
    fs: { allow: ['..'] },
  },
})
