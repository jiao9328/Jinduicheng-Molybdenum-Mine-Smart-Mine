/**
 * 术语归一化 —— 指导书第 5 节。
 *
 * 全部是**纯函数**（词典当参数传进来，不在这里读库），理由与本仓库
 * `check-ground-cover.mjs` 那批判据一样：纯函数能被自证直接喂样本，
 * 不需要起服务、不需要浏览器，毫秒级就能证明「它真的会错」。
 *
 * ## 四个容易写错的地方
 *
 * 1. **替换必须按长度降序。** 词典里有「尾矿库」也有「库」，有「边坡监测」
 *    也有「监测」。若按短的先换，`边坡监测` 会先被换成别的、后面那条再也匹配不上。
 *    实测过的同类坑：本项目 `PREFIXES` 表（`sceneTargets.ts:82`）就是因为
 *    「长的必须排在前面」才在注释里专门标了一句。
 *
 * 2. **中文数字要连「十」一起处理。** 台阶号只到个位数的矿上不会暴露这个问题，
 *    但「十五号台阶」如果逐字替换会变成「15号台阶」还是「1 5号台阶」全看写法。
 *    这里一次匹配整个数字串。
 *
 * 3. **标准词自己也要进替换表（映射到它自己）。** 见 `normalizeTerms` 里那段。
 *
 * 4. **替换不许落在真实地名里面。** 见 `insideKnownPlace` 里那段。
 *
 * 5. **替换不许吞掉后面的序号。** 见 `followedByOrdinal` 里那段。
 *
 * 第 1 条管「谁先匹配」，后三条管「这次匹配该不该动手」——
 * 少了它们，归一化会**把用户说的那个地方/那台设备改成别的**
 * （实测：「排土场复垦区」→「排土场场复垦区」，导航飞到隔壁的排土场；
 * 「皮带二」→「皮带廊二」，查无此设备）。两次都是静默的错目标，不报错。
 */
import { KNOWN_PLACES } from './vocab.mjs'

/** 中文数字 → 阿拉伯。只覆盖 1~99，台阶号/帮号/设备号都够用 */
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/**
 * 把中文数字串转成数字，认不出来返回 null。
 *
 * 支持「三」「十」「十五」「二十」「二十三」。**不做**「一百二十三」——
 * 矿上的编号到不了三位数，多写的分支只会多一处没人测过的代码。
 */
export function cnToNumber(text) {
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  if (!/^[零一二两三四五六七八九十]+$/.test(text)) return null

  const ten = text.indexOf('十')
  if (ten < 0) {
    // 纯个位：只认单字，「一二三」这种连写视为认不出来
    return text.length === 1 ? (CN_DIGIT[text] ?? null) : null
  }

  const head = text.slice(0, ten)
  const tail = text.slice(ten + 1)
  const tens = head === '' ? 1 : (CN_DIGIT[head] ?? null)
  const ones = tail === '' ? 0 : (CN_DIGIT[tail] ?? null)
  if (tens === null || ones === null) return null
  return tens * 10 + ones
}

/**
 * 编号归一化：`三号` / `3号` / `3#` / `第3` / `三台阶` 统一成 `3号`。
 *
 * 指导书第 5 节的原话是「三号=3号=3#」。这里把 `#` 与「第」也一并收进来 ——
 * 大屏前面的人是张嘴说话，不会按文档用词。
 *
 * ⚠️ 只归一化**紧挨着台阶/帮/设备类量词**的编号，不做全局替换。
 * `3#` 在备件编码里是合法字符，全局换成「3号」会把 `SP-3#` 这类标识改坏。
 */
export function normalizeNumber(text) {
  if (!text) return text

  // 3号 / 3# / 第3号 / 三号 / 三台阶 / 3台阶
  return text.replace(
    /(第)?([0-9]+|[零一二两三四五六七八九十]+)\s*(号|#|＃)(?=\s*(台阶|帮|坡|钻机|卡车|铲车|机|点|线|区|站|坝|库|廊|带|段|面|号|$))/g,
    (_m, _di, raw) => {
      const n = cnToNumber(raw)
      return n === null ? _m : `${n}号`
    }
  )
}

/** 正则元字符转义 —— 词条是数据，里面完全可能出现 `.` `(` 这类字符 */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 真实地名按长度降序 —— `insideKnownPlace` 用 */
const PLACES_LONGEST_FIRST = [...KNOWN_PLACES].sort((a, b) => b.length - a.length)

/**
 * 这次命中 `[offset, offset+len)` 是不是落在某个**真实地名**里面。
 *
 * ## 为什么必须有这一条
 *
 * 归一化是「口语 → 标准词」，可地名恰恰是**最不该被改的东西**：
 * 它要原样送到前端去解析坐标（`src/duner/places.ts`）。同义词表一旦和
 * 地名撞上，改出来的就是一个不存在的地方，或者更糟 —— 一个存在但**不是用户说的那个**地方：
 *
 * ```
 * 东帮运输道  --(运输道→主运输道路)-->  东帮主运输道   ✗ 前端认不出，回一句"没找到"
 * 厂区        --(厂区→选矿厂)-->        选矿厂         ✗ 能飞，但飞到隔壁那个锚点去了
 * ```
 *
 * 第二种是这里唯一真正的坏结果：第一个至少还是**如实的失败**，
 * 第二个是「看起来成功了」。所以判据不看词表、看**地名清单**：
 * 命中位落在任何一个真实地名的跨度里，就不许替换。
 *
 * 用 `indexOf` 逐个找而不是只比一次，是因为同一个地名可能在句子里出现两次：
 * 「带我去东帮运输道，东帮运输道那边」—— 只检查第一处会漏掉第二处。
 */
/**
 * 紧跟在命中后面的**序号**。`皮带二` 的「二」、`皮带3` 的「3」都算。
 *
 * `号/#` 也收进来，因为 `皮带2号` 是同一个东西的另一种写法。
 */
const ORDINAL_TAIL = /^[零一二两三四五六七八九十\d]+[号#＃]?/

/**
 * 这次命中后面是不是**紧跟着一个序号** —— 是的话它多半是**设备/点位的名字**，
 * 不许替换。
 *
 * ## 为什么和 `insideKnownPlace` 是同一类规矩
 *
 * 那条管的是「别把真实地名改坏」，这条管的是「别把真实**设备名**改坏」，
 * 道理一模一样：点名要原样往下送的字符串，不该被词典啃掉一块。
 *
 * 实测怎么撞上的：`dict.mjs` 的种子里有 `皮带廊: ['皮带','运输皮带']`。
 * 用户说「确认告警 皮带二」——`皮带二` 是 mock 里一台真实设备的编号写法，
 * 而「皮带」是它的同义词，于是一刀切下去变成 **`皮带廊二`**：
 *
 * ```
 * 确认告警 皮带二  --(皮带→皮带廊)-->  确认告警 皮带廊二   ✗ 查无此设备
 * ```
 *
 * 和 `排土场复垦区` 那次一样，**不报任何异常**，只是"没听懂"。
 *
 * ## 为什么不会误伤「1号矿卡」这类
 *
 * 那些句子里序号在**前面**（序号+机种），被保护的是词尾后面跟着的那个序号。
 * 所以「1号矿卡」照旧全须全尾地被换成「1号矿用卡车」。
 * 反过来的写法（「矿卡2」）本来就不受支持 —— `ENTITY_NUM_RE` 要求「数字+号+机种」，
 * 保不保护都认不出来。
 */
function followedByOrdinal(text, offset, len) {
  return ORDINAL_TAIL.test(text.slice(offset + len, offset + len + 3))
}

function insideKnownPlace(text, offset, len) {
  const end = offset + len
  for (const p of PLACES_LONGEST_FIRST) {
    // 盖住一次命中，地名至少要和它一样长（等长时只可能是它自己）
    if (p.length < len) continue
    let at = text.indexOf(p)
    while (at >= 0) {
      if (at <= offset && at + p.length >= end) return true
      at = text.indexOf(p, at + 1)
    }
  }
  return false
}

/**
 * 按词典做同义词归一化。
 *
 * ## 为什么必须**一遍扫完**，不能一个词一个词地 replace
 *
 * 逐词替换的写法会**替换进自己刚生成的结果里**。实测踩到的例子：
 * 词典里有 `矿用卡车: ['矿卡','自卸车','大车','卡车']`，
 * 「1号矿卡」先被换成「1号矿用卡车」，接着轮到「卡车 → 矿用卡车」这条时，
 * 它把**刚生成的那个词里的「卡车」**又换了一遍：
 *
 * ```
 * 1号矿卡 → 1号矿用卡车 → 1号矿用矿用卡车
 * ```
 *
 * 于是后面按「序号+机种」解析设备的代码全部落空，
 * 而用户说的话明明是最普通的那一句。**这个错不会报任何异常** ——
 * 它只是让一条正常指令变成"没听懂"。
 *
 * 所以这里拼成**一个**正则一次扫完：每个字符只被消费一次，
 * 替换结果不会被重新扫描。备选项按长度降序排列，
 * 保证「矿用卡车」优先于「矿卡」（正则的选择分支是先到先得）。
 *
 * @param {string} text
 * @param {{term:string, synonyms:string[]}[]} dict 标准词 → 同义词
 * @returns {{text:string, hits:{from:string,to:string}[]}} 归一化结果与命中记录
 *
 * 返回命中记录是为了**让审计能说清「它凭什么这么理解」**。
 * 只返回字符串的话，用户看到「皮带廊图层已打开」而自己说的是「边皮廊」，
 * 没法判断是纠错成功还是听岔了。
 */
export function normalizeTerms(text, dict) {
  if (!text) return { text, hits: [] }

  // 展开成 (词 → 换成什么)。两类：
  //   同义词 → 标准词（「矿卡」→「矿用卡车」）
  //   标准词 → **它自己**
  //
  // 第二类是必需的，缺了它「标准词里含着自己的同义词」就会**自我叠加**：
  //   作业人员定位 --(人员定位→作业人员定位)--> 作业作业人员定位
  //   人员当日轨迹 --(当日轨迹→人员当日轨迹)--> 人员人员当日轨迹
  // 这两个例子能歪打正着（含标准词的子串仍在，`extractLayers` 照样认得出），
  // 所以它不会报错、只在审计的 `normalized` 字段里一直歪着。
  // 真正的坏例子是 `排土场复垦区` → `排土场场复垦区`：最长匹配退化成「排土场」，
  // 于是「带我去排土场复垦区」飞到了隔壁的排土场 —— 一次静默的错目的地。
  // 让标准词先占住自己那段，同义词就没有下嘴的地方了。
  //
  // 顺序：**先收同义词再收标准词**。反过来的话，标准词的自映射会把
  // 别的词条里同名的同义词挡掉（词表是人维护的，这种撞名迟早会有）。
  const map = new Map()
  for (const entry of dict) {
    for (const syn of entry.synonyms ?? []) {
      if (syn && !map.has(syn)) map.set(syn, entry.term)
    }
  }
  for (const entry of dict) {
    if (entry.term && !map.has(entry.term)) map.set(entry.term, entry.term)
  }
  if (!map.size) return { text, hits: [] }

  const words = [...map.keys()].sort((a, b) => b.length - a.length)
  const re = new RegExp(words.map(escapeRe).join('|'), 'g')

  const hits = []
  const out = text.replace(re, (matched, offset) => {
    const to = map.get(matched)
    if (to === matched) return matched // 标准词自己：不动，也不算一次命中
    // 两道"别动手"的闸门，都不算命中（没改就不该记一笔）
    if (insideKnownPlace(text, offset, matched.length)) return matched
    if (followedByOrdinal(text, offset, matched.length)) return matched
    hits.push({ from: matched, to })
    return to
  })
  return { text: out, hits }
}

/** 编号 + 术语一起做。顺序要紧：先编号后术语，否则「三号」会被术语表里的单字撞掉 */
export function normalize(text, dict = []) {
  const numed = normalizeNumber(text ?? '')
  const { text: termed, hits } = normalizeTerms(numed, dict)
  return { text: termed, hits, numbered: numed !== (text ?? '') }
}
