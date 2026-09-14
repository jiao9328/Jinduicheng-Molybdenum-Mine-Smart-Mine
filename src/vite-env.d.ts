/// <reference types="vite/client" />

/**
 * 环境变量类型声明。
 *
 * 不写在这里的话 `import.meta.env.VITE_*` 会报 TS2339
 * （Property 'env' does not exist on type 'ImportMeta'）。
 * 新增环境变量时同步补到下面的接口，并在 README 的「环境变量」表里登记。
 */
interface ImportMetaEnv {
  /** REST 接口前缀，默认 /api */
  readonly VITE_API_BASE_URL?: string
  /** WebSocket 地址，默认同源 /ws */
  readonly VITE_WS_URL?: string
  /** 接口不可用时是否降级到内置数据，显式设为 'false' 关闭 */
  readonly VITE_ALLOW_MOCK_FALLBACK?: string
  /**
   * Cesium Ion 访问令牌。
   *
   * 注意：Vite 会把 VITE_* 内联进客户端产物，这个令牌对访问者可见。
   * 这是 Cesium Ion 的常规用法，但应在 ion.cesium.com 给令牌配置域名白名单。
   */
  readonly VITE_CESIUM_ION_TOKEN?: string
  /**
   * 是否启用在线实景三维（Google Photorealistic 3D Tiles）。
   *
   * 默认关闭：需要外网，且 Cesium Ion 对该资产的授权提示是
   * "Upgrade for commercial use"，正式交付前需确认商用许可。
   * 显式设为 'true' 才启用，加载失败会自动回退程序化场景。
   */
  readonly VITE_USE_ONLINE_3D?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
