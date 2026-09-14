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
    open: false,
    /**
     * 开发时把 /api 转给后端（`npm run serve`，8787）。
     *
     * 不配代理的话，dev 下所有接口都会 404 —— 那本来会触发前端降级到 mock，
     * 页面照样能看，于是「接口其实通不通」在开发时完全看不出来。
     * 配上之后 dev 与生产（`server/index.mjs` 同源托管）行为一致。
     *
     * 后端没起时这里会回 502/504，前端按「接口未就绪」降级到 mock —— 与
     * 原来的表现一致，所以忘了起后端也不会把页面搞白。
     */
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: false }
    }
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
