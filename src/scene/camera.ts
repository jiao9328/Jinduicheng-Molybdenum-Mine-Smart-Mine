import * as Cesium from 'cesium'
import { HOME_WAYPOINT, waypointToFlyTo, type SceneWaypoint } from './sceneConfig'

/** 立即切到某个机位（无动画），用于初始化 */
export function setWaypoint(viewer: Cesium.Viewer, wp: SceneWaypoint = HOME_WAYPOINT) {
  const { destination, orientation } = waypointToFlyTo(wp)
  viewer.camera.flyTo({
    destination,
    orientation,
    duration: 0
  })
}

/** 带动画飞到某个机位，用于「点击 Tab 切换视角」 */
export function flyToWaypoint(
  viewer: Cesium.Viewer,
  wp: SceneWaypoint,
  duration = 2.5
): Promise<void> {
  const { destination, orientation } = waypointToFlyTo(wp)

  return new Promise((resolve) => {
    viewer.camera.flyTo({
      destination,
      orientation,
      duration,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      complete: () => resolve(),
      cancel: () => resolve()
    })
  })
}
