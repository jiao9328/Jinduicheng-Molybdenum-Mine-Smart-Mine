import * as Cesium from 'cesium'

/**
 * 流动线材质。
 *
 * 用于避灾路线：底色半透明，其上有一段高亮光带沿路径循环流动，
 * 指示「撤离方向」。对应开发指导文档 12.4 的「流动材质」要求。
 *
 * 实现方式：自定义 GLSL。以 st.s（沿线的归一化弧长）为相位，
 * 乘上重复次数并减去时间，取 fract 得到循环移动的波形，
 * 再用 smoothstep 塑成梯形光带，最后与白色混合提亮。
 */

const FLOW_LINE_TYPE = 'FlowLineManual'

/** 供 Property 与 Material 共用的 uniform 定义 */
const FABRIC = {
  type: FLOW_LINE_TYPE,
  uniforms: {
    color: new Cesium.Color(0, 0.9, 1, 1),
    speed: 8.0,
    glowWidth: 0.28,
    repeat: 6.0,
    time: 0.0
  },
  source: /* glsl */ `
    czm_material czm_getMaterial(czm_materialInput materialInput) {
      czm_material material = czm_getDefaultMaterial(materialInput);

      // st.s 是沿路径归一化的弧长（0~1）
      float phase = fract(materialInput.st.s * repeat - time * speed * 0.02);

      // 以 0.5 为中心做对称光带：中间最亮，两端平滑衰减
      float halfWidth = max(glowWidth, 0.001) * 0.5;
      float glow = 1.0 - smoothstep(0.0, halfWidth, abs(phase - 0.5));
      glow = pow(glow, 1.8);

      vec3 baseColor = color.rgb;
      vec3 glowColor = mix(baseColor, vec3(1.0), 0.8);

      material.diffuse = mix(baseColor, glowColor, glow);
      // 底色保持可见，光带位置接近不透明，形成「流光」观感
      material.alpha = color.a * (0.45 + 0.55 * glow);

      return material;
    }
  `
}

/**
 * `Material._materialCache` 是 Cesium 官方自定义材质的注册入口
 * （官方 Custom Materials 教程即用此法），但类型定义里没有导出它。
 * 运行时确实存在（Build/CesiumUnminified 中 `Material._materialCache = {`），
 * 这里收窄成一个最小接口，避免整段退化成 any。
 */
interface MaterialCache {
  addMaterial(type: string, material: { fabric: unknown; translucent: boolean }): void
}

/** 注册材质，全局调用一次即可 */
let registered = false

export function registerFlowLineMaterial() {
  if (registered) return
  const cache = (Cesium.Material as unknown as { _materialCache: MaterialCache })
    ._materialCache
  cache.addMaterial(FLOW_LINE_TYPE, {
    fabric: FABRIC,
    translucent: true
  })
  registered = true
}

/**
 * 取「当天已过的秒数」。
 *
 * JulianDate 的 startOfDay / secondsOfDay 是实例方法而非静态方法，
 * 直接调静态形式会拿到 undefined。这里用 toIso8601 取到 UTC 日期部分、
 * 补回零点后做差值，不依赖版本差异较大的 API。
 */
function secondsOfDay(time: Cesium.JulianDate): number {
  try {
    const iso = Cesium.JulianDate.toIso8601(time, 0)
    const midnight = Cesium.JulianDate.fromIso8601(`${iso.slice(0, 10)}T00:00:00Z`)
    return Cesium.JulianDate.secondsDifference(time, midnight)
  } catch {
    return 0
  }
}

/**
 * 流动线材质属性。
 *
 * 注意不能直接继承 Cesium.MaterialProperty —— 那是需要实现 abstract
 * 方法体系的接口，这里按 Cesium 约定实现 getValue / equals / getType 三件套即可。
 * time 用当天的秒数推进，因此多条线天然保持相位同步。
 */
export class FlowLineMaterialProperty {
  private _definitionChanged = new Cesium.Event()
  private _color: Cesium.Color
  private _speed: number
  private _glowWidth: number
  private _repeat: number

  constructor(options: {
    color?: Cesium.Color
    /** 流动速度，值越大越快 */
    speed?: number
    /** 光带宽度占单段的比例，0~1 */
    glowWidth?: number
    /** 沿线重复段数，越多光带越密 */
    repeat?: number
  } = {}) {
    this._color = options.color ?? Cesium.Color.fromCssColorString('#00e5ff')
    this._speed = options.speed ?? 8
    this._glowWidth = options.glowWidth ?? 0.28
    this._repeat = options.repeat ?? 6
  }

  get isConstant() {
    return false
  }

  get definitionChanged() {
    return this._definitionChanged
  }

  getType() {
    return FLOW_LINE_TYPE
  }

  getValue(time: Cesium.JulianDate, result?: Record<string, unknown>) {
    const out = result ?? {}
    out.color = this._color
    out.speed = this._speed
    out.glowWidth = this._glowWidth
    out.repeat = this._repeat
    out.time = secondsOfDay(time)
    return out
  }

  equals(other: unknown) {
    return (
      this === other ||
      (other instanceof FlowLineMaterialProperty &&
        Cesium.Color.equals(this._color, other._color) &&
        this._speed === other._speed &&
        this._glowWidth === other._glowWidth &&
        this._repeat === other._repeat)
    )
  }
}

/** 便捷构造：给一条折线生成流动材质 */
export function createFlowMaterial(color: string, speed = 8) {
  registerFlowLineMaterial()
  return new FlowLineMaterialProperty({
    color: Cesium.Color.fromCssColorString(color),
    speed,
    repeat: 8,
    glowWidth: 0.3
  }) as unknown as Cesium.MaterialProperty
}
