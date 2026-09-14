/**
 * 从离线影像里自动找出「蓝灰色屋顶建筑」的实测位置。
 *
 * 为什么需要它：`mineLayout.ts` 里的建筑坐标是**人眼判读**出来的，
 * 而识图模型对密集 UI 与影像细节的读数不稳定，问它「偏了多少米」得不到可靠答案。
 * 但「哪块像素是蓝灰色屋顶」是个纯数值问题，可以精确算出来。
 *
 * 做法：在 z17 影像上取蓝度（B - max(R,G)）超阈值的像素，
 * 做连通域分析，输出每个屋顶的质心、外接矩形、面积。
 * 然后拿这份**实测清单**去比 `mineLayout.BUILDINGS` 的配置值，偏移量一目了然。
 *
 * 用法：
 *   node scripts/detect-buildings.mjs                 # 选矿厂区
 *   node scripts/detect-buildings.mjs 109.955 34.328 109.977 34.345
 */
import { chromium } from 'playwright'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = resolve(root, 'public')
const Z = 17
const TMP_HTML = resolve(publicDir, '__detect-buildings.html')

const layout = await import('../src/scene/mineLayout.ts')

/** 蓝度阈值：蓝通道高出红/绿较大者多少才算「蓝」。屋顶偏灰时调低。 */
const BLUENESS = +(process.env.BLUENESS ?? 12)
/** 亮度下限，滤掉阴影与深水 */
const MIN_LUM = +(process.env.MIN_LUM ?? 45)
/** 饱和度上限（浅色屋顶判据）。调低只留更纯的灰白面，调高会开始收进裸土。 */
const MAX_SAT = +(process.env.MAX_SAT ?? 0.16)
/** `blue` 只认蓝顶；`bright` 另收浅色屋顶。 */
const MODE = process.env.MODE ?? 'bright'

const args = process.argv.slice(2)
const box =
  args.length >= 4
    ? { lon0: +args[0], lat0: +args[1], lon1: +args[2], lat1: +args[3] }
    : { lon0: 109.952, lat0: 34.326, lon1: 109.98, lat1: 34.346 }

const lonToPx = (lon) => ((lon + 180) / 360) * Math.pow(2, Z) * 256
const latToPx = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180)
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * Math.pow(2, Z) * 256
}

const x0 = lonToPx(box.lon0)
const x1 = lonToPx(box.lon1)
const y0 = latToPx(box.lat1)
const y1 = latToPx(box.lat0)
const W = Math.round(x1 - x0)
const H = Math.round(y1 - y0)

const tx0 = Math.floor(x0 / 256)
const tx1 = Math.floor((x1 - 1) / 256)
const ty0 = Math.floor(y0 / 256)
const ty1 = Math.floor((y1 - 1) / 256)

const tiles = []
for (let tx = tx0; tx <= tx1; tx++) {
  for (let ty = ty0; ty <= ty1; ty++) {
    tiles.push({
      x: tx * 256 - x0,
      y: ty * 256 - y0,
      src: `map-tiles/imagery/${Z}/${tx}/${ty}.jpg`
    })
  }
}

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const TILES = ${JSON.stringify(tiles)};
const W = ${W}, H = ${H};
const c = document.getElementById('c');
const ctx = c.getContext('2d', { willReadFrequently: true });
window.__ready = (async () => {
  await Promise.all(TILES.map(t => new Promise(res => {
    const img = new Image();
    img.onload = () => { ctx.drawImage(img, t.x, t.y, 256, 256); res(); };
    img.onerror = () => res();
    img.src = t.src;
  })));
  return true;
})();
window.__analyze = () => {
  const d = ctx.getImageData(0, 0, W, H).data;
  // 两类屋顶都收：
  //   1) 蓝顶 —— 蓝通道明显高于红绿
  //   2) 浅色顶（灰/白/浅蓝彩钢瓦）—— 亮度高、饱和度低、且不是植被
  // 只认蓝顶会漏掉厂房区里大量浅灰屋顶，那些恰恰是最主要的建筑。
  const mask = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const lum = (r + g + b) / 3;
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    const blueness = b - Math.max(r, g);
    const vegetated = g > r + 8 && g > b + 8;
    const roof = (blueness > ${BLUENESS} && lum > ${MIN_LUM}) ||
                 (${MODE === 'bright'} && lum > ${MIN_LUM} && sat < ${MAX_SAT} && !vegetated);
    if (roof) mask[i] = 1;
  }
  // 连通域（4 邻域，显式栈避免递归爆栈）
  const comps = [];
  const stack = new Int32Array(W * H);
  const seen = new Uint8Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let n = 0, sx = 0, sy = 0;
    let minX = W, maxX = -1, minY = H, maxY = -1;
    let sr = 0, sg = 0, sb = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % W, y = (idx / W) | 0;
      n++; sx += x; sy += y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const p = idx * 4;
      sr += d[p]; sg += d[p + 1]; sb += d[p + 2];
      if (x > 0     && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x < W - 1 && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (y > 0     && mask[idx - W] && !seen[idx - W]) { seen[idx - W] = 1; stack[sp++] = idx - W; }
      if (y < H - 1 && mask[idx + W] && !seen[idx + W]) { seen[idx + W] = 1; stack[sp++] = idx + W; }
    }
    comps.push({
      n, cx: sx / n, cy: sy / n,
      minX, maxX, minY, maxY,
      w: maxX - minX + 1, h: maxY - minY + 1,
      r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n)
    });
  }
  return comps;
};
</script></body></html>`

// file:// 页面把 file:// 图片画进 canvas 会污染画布，getImageData 直接抛 SecurityError。
// 本地分析脚本，放开这个限制是安全的。
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] })
const page = await browser.newPage({ viewport: { width: W, height: H } })
writeFileSync(TMP_HTML, html, 'utf8')
await page.goto(pathToFileURL(TMP_HTML).href, { waitUntil: 'load' })
await page.evaluate(() => window.__ready)
const comps = await page.evaluate(() => window.__analyze())
await browser.close()
rmSync(TMP_HTML, { force: true })

// 像素 → 经纬度。入参都是**全局**墨卡托像素（含 y0 偏移），不要重复加。
const pxToLon = (px) => (px / (Math.pow(2, Z) * 256)) * 360 - 180
const pxToLat = (py) => {
  const n = Math.PI - (2 * Math.PI * py) / (Math.pow(2, Z) * 256)
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))
}
const metersPerLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180)
const METERS_PER_LAT = 110540
/** z17 在本纬度上的地面分辨率（米/像素） */
const mpp = (lat) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, Z)

/** 最小面积阈值（px²）。z17 约 1m/px，滤掉小房与噪点。 */
const MIN_AREA = +process.env.MIN_AREA || 400
const found = comps
  .filter((c) => c.n >= MIN_AREA)
  .map((c) => {
    const lon = pxToLon(c.cx + x0)
    const lat = pxToLat(c.cy + y0)
    const s = mpp(lat)
    return {
      lon,
      lat,
      widthM: c.w * s,
      depthM: c.h * s,
      area: c.n,
      fill: c.n / (c.w * c.h),
      rgb: `${c.r},${c.g},${c.b}`,
      bboxLon: [pxToLon(c.minX + x0), pxToLon(c.maxX + x0)],
      bboxLat: [pxToLat(c.maxY + y0), pxToLat(c.minY + y0)]
    }
  })
  .sort((a, b) => b.area - a.area)

const f = (v, n = 5) => v.toFixed(n)

console.log(`\n检测到 ${found.length} 处蓝顶区域（面积 ≥ ${MIN_AREA}px²），按面积降序：\n`)
console.log('  #   中心经度      中心纬度     宽×深(米)      面积px²  填充率  平均RGB')
console.log('  ' + '-'.repeat(78))
found.forEach((d, i) => {
  console.log(
    `  ${String(i + 1).padStart(2)}  ${f(d.lon)}   ${f(d.lat)}   ` +
      `${String(Math.round(d.widthM)).padStart(4)}×${String(Math.round(d.depthM)).padStart(4)}   ` +
      `${String(d.area).padStart(7)}   ${d.fill.toFixed(2)}   ${d.rgb}`
  )
})

// ---- 与配置值比对 ----
console.log('\n\n配置的建筑坐标 vs 最近的实测蓝顶区域：\n')
console.log('  建筑名            配置中心              最近实测中心          偏移(米)  实测尺寸(米)   配置尺寸(米)')
console.log('  ' + '-'.repeat(104))
for (const b of layout.BUILDINGS) {
  let best = null
  let bestD = Infinity
  for (const d of found) {
    const dx = (d.lon - b.lon) * metersPerLon(b.lat)
    const dy = (d.lat - b.lat) * METERS_PER_LAT
    const dist = Math.hypot(dx, dy)
    if (dist < bestD) {
      bestD = dist
      best = { d, dx, dy }
    }
  }
  if (!best) {
    console.log(`  ${b.name.padEnd(14)}  —  影像中未找到蓝顶区域`)
    continue
  }
  const dir = `${best.dx > 0 ? '东' : '西'}${Math.abs(best.dx).toFixed(0)} ${best.dy > 0 ? '北' : '南'}${Math.abs(best.dy).toFixed(0)}`
  console.log(
    `  ${b.name.padEnd(14)}  ${f(b.lon)} ${f(b.lat)}   ${f(best.d.lon)} ${f(best.d.lat)}   ` +
      `${String(Math.round(bestD)).padStart(4)}m (${dir})   ` +
      `${Math.round(best.d.widthM)}×${Math.round(best.d.depthM)}   ${b.width}×${b.depth}`
  )
}
console.log()
