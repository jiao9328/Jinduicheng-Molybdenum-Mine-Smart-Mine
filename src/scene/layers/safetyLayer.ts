import * as Cesium from 'cesium'
// 类型只从接口层取：图层与页面一样不直接依赖 @/mock/*
import type { SafetyMarker } from '@/api/safety'
import { MINE_ELEVATION } from '../sceneConfig'
import { sampleGroundHeights } from '../localTerrain'

/**
 * 安全风险标注图层。
 *
 * 在三维场景上叠加风险点：蓝色立体方块标记设施、红色圆圈圈定风险范围、
 * 带背景的 label 显示告警文案。对应开发指导文档 12.3。
 *
 * **高度全部靠采样**：标注的高度由三维底座（离线 DEM 地形或实景三维）在运行时给出，
 * 再按几何关系抬起。数据里不写绝对高度——底座一换，写死的高度必然错。
 */

const LEVEL_COLOR: Record<string, Cesium.Color> = {
  高: Cesium.Color.fromCssColorString('#ff4d4f'),
  中: Cesium.Color.fromCssColorString('#ff9f1c'),
  低: Cesium.Color.fromCssColorString('#00e5ff')
}

/** 蓝色立体方块的边长（米） */
const CUBE_SIZE = 46

export async function buildSafetyLayer(
  viewer: Cesium.Viewer,
  markers: SafetyMarker[]
): Promise<void> {
  const entities = viewer.entities

  const ground = await sampleGroundHeights(
    markers.map((m) => ({ key: m.id, lon: m.lon, lat: m.lat })),
    MINE_ELEVATION
  )

  for (const m of markers) {
    const base = ground[m.id] ?? MINE_ELEVATION
    const color = LEVEL_COLOR[m.level] ?? LEVEL_COLOR['低']

    // ---- 设施标记：蓝色立体方块，坐在采样到的地面上 ----
    entities.add({
      id: `safety-facility-${m.id}`,
      name: m.name,
      position: Cesium.Cartesian3.fromDegrees(m.lon, m.lat, base + CUBE_SIZE / 2),
      box: {
        dimensions: new Cesium.Cartesian3(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE),
        material: Cesium.Color.fromCssColorString('#2f7fd4').withAlpha(0.85),
        outline: true,
        outlineColor: Cesium.Color.fromCssColorString('#7fd4ff'),
        outlineWidth: 1.5
      }
    })

    // ---- 名称标签 ----
    entities.add({
      id: `safety-label-${m.id}`,
      name: m.name,
      position: Cesium.Cartesian3.fromDegrees(m.lon, m.lat, base + CUBE_SIZE * 2),
      label: {
        text: m.name,
        font: '13px PingFang SC, Microsoft YaHei, sans-serif',
        fillColor: Cesium.Color.WHITE,
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString('#001a2e').withAlpha(0.78),
        backgroundPadding: new Cesium.Cartesian2(7, 4),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(300, 1.0, 3000, 0.6)
      }
    })

    // ---- 风险范围圆圈 + 告警文案 ----
    if (m.circle) {
      const circleColor = Cesium.Color.fromCssColorString(m.circle.color)

      entities.add({
        id: `safety-circle-${m.id}`,
        name: `${m.name}风险范围`,
        position: Cesium.Cartesian3.fromDegrees(m.lon, m.lat, base + 2),
        ellipse: {
          semiMajorAxis: m.circle.radius,
          semiMinorAxis: m.circle.radius,
          material: circleColor.withAlpha(0.16),
          outline: true,
          outlineColor: circleColor,
          outlineWidth: 2,
          height: base + 2
        }
      })

      // 告警标签：黄色背景，浮在圈的上方
      entities.add({
        id: `safety-alert-${m.id}`,
        name: '告警信息',
        position: Cesium.Cartesian3.fromDegrees(
          m.lon,
          m.lat + (m.circle.radius * 1.15) / 110540,
          base + CUBE_SIZE * 3
        ),
        label: {
          text: m.circle.label,
          font: '12px PingFang SC, Microsoft YaHei, sans-serif',
          fillColor: Cesium.Color.fromCssColorString('#3a2a00'),
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('#ffd60a').withAlpha(0.95),
          backgroundPadding: new Cesium.Cartesian2(8, 5),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(300, 1.0, 3000, 0.65)
        }
      })
    }
  }
}
