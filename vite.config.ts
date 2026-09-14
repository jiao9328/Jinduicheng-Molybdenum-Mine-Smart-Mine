import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [
    vue(),
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia'],
      resolvers: [ElementPlusResolver()],
      dts: 'src/types/auto-imports.d.ts'
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: 'src/types/components.d.ts'
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
        additionalData: `@use "@/styles/variables.scss" as *;`,
        silenceDeprecations: ['import', 'legacy-js-api', 'color-functions', 'global-builtin']
      }
    }
  },
  server: {
    host: true,
    port: 5173,
    open: false
  },
  build: {
    chunkSizeWarningLimit: 8192,
    rollupOptions: {
      output: {
        manualChunks: {
          cesium: ['cesium'],
          echarts: ['echarts'],
          element: ['element-plus']
        }
      }
    }
  }
})
