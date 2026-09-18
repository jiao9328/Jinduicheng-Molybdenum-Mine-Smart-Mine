/**
 * 矿山术语词典 —— 指导书第 5 节，落在 `dict_term` 表上，可热更新。
 *
 * ## 种子为什么是 `INSERT ... ON CONFLICT DO NOTHING` 而不是先清后灌
 *
 * `scripts/seed-db.mjs` 的规矩是「先清后灌、幂等」，那对**演示台账**是对的
 * （它要保证每次种子结果一致）。词典不一样：它是**运行时可被管理员改的配置**，
 * 用先清后灌会在每次重启时把管理员加的矿上土话**悄悄抹掉**，而且
 * 界面上完全看不出来 —— 正是本仓库反复记过的那类「静默丢失」。
 *
 * 所以这里只在词条**不存在**时插入。改种子想生效，得改词条或删库重建，
 * 这是刻意付出的代价：宁可新种子不生效，也不抹掉人改过的数据。
 *
 * ## 同义词是从哪来的
 *
 * 两份来源，都是**项目里已经存在的事实**，不是凭空编的：
 * 1. 指导书第 5 节那张表（采场/大坑、矿卡/大车…）；
 * 2. 本项目自己的词汇表：`src/scene/sceneTargets.ts` 的 `AREA_ANCHORS`（地名）、
 *    `src/mock/digitalTwin.ts` 的设备与监测点、各三维页的图层名。
 *    这部分的用处是让「带我去北帮3号台阶」能落到真实的 `SL-01` / `DR-01` 上。
 */
import { normalize } from './normalize.mjs'

/**
 * 内置词条。`category` 与指导书第 5 节的类别一致，
 * `synonyms` 里刻意收了几条**错别字与口语**（边皮廊/大车/坑里），
 * 因为大屏前面的人是说话不是打字。
 */
export const SEED_TERMS = [
  // -- 区域 --
  { term: '露天采坑', category: '区域', synonyms: ['采场', '大坑', '主坑', '采坑', '坑里', '露天坑'] },
  { term: '排土场', category: '区域', synonyms: ['废石场', '排弃场', '排土'] },
  { term: '尾矿库', category: '区域', synonyms: ['尾矿坝', '尾矿池', '尾矿'] },
  { term: '选矿厂', category: '区域', synonyms: ['选厂', '主厂房', '磨浮车间', '厂区', '选矿'] },
  { term: '粗碎站', category: '区域', synonyms: ['破碎站', '粗碎', '粗破'] },

  // -- 位置 --
  { term: '台阶', category: '位置', synonyms: ['梯段', '平台', '阶段'] },
  { term: '北帮', category: '方位', synonyms: ['北边坡', '北面', '北边'] },
  { term: '南帮', category: '方位', synonyms: ['南边坡', '南面', '南边'] },
  { term: '东帮', category: '方位', synonyms: ['东边坡', '东面', '东边'] },
  { term: '西帮', category: '方位', synonyms: ['西边坡', '西面', '西边'] },
  { term: '工作面', category: '位置', synonyms: ['作业面', '掌子面'] },
  { term: '北帮采剥面', category: '位置', synonyms: ['采剥面', '北采剥'] },
  { term: '主运输道路', category: '位置', synonyms: ['运输道', '主运道', '运输道路'] },
  { term: '坑底集水池', category: '位置', synonyms: ['集水池', '坑底水池', '水仓'] },
  { term: '排土场复垦区', category: '位置', synonyms: ['复垦区'] },
  { term: '东帮爆破区', category: '位置', synonyms: ['爆破区', '爆区'] },

  // -- 设施 --
  { term: '皮带廊', category: '设施', synonyms: ['皮带机', '运输廊', '廊道', '皮带', '边皮廊', '皮代廊'] },
  { term: '安全监测点', category: '监测', synonyms: ['监测点', '监测站'] },

  // -- 设备 --
  { term: '牙轮钻机', category: '设备', synonyms: ['钻机', '穿孔设备', '穿孔机'] },
  { term: '矿用卡车', category: '设备', synonyms: ['矿卡', '自卸车', '大车', '卡车'] },
  { term: '前装机', category: '设备', synonyms: ['装载机', '铲车', '前装'] },

  // -- 监测 --
  { term: '边坡位移', category: '监测', synonyms: ['边坡监测', '滑坡位移', 'GNSS', '位移监测', '边坡'] },

  // -- 安全 --
  { term: '隐患', category: '安全', synonyms: ['风险点', '问题项', '三违', '隐患点'] },
  { term: '应急预案', category: '安全', synonyms: ['预案', '处置方案'] },
  { term: '避灾路线', category: '安全', synonyms: ['撤离路线', '逃生路线', '避灾', '疏散路线'] },

  // -- 属性 --
  { term: '台阶高度', category: '属性', synonyms: ['台阶标高', '标高'] },

  // -- 平台自己的图层名（让「打开边坡监测」能落到真实图层上）--
  { term: '作业人员定位', category: '图层', synonyms: ['人员定位', '人员分布', '人员'] },
  { term: '定位基站', category: '图层', synonyms: ['基站', '通讯基站'] },
  { term: '人员当日轨迹', category: '图层', synonyms: ['当日轨迹', '人员轨迹', '轨迹'] },
  { term: '风险分布', category: '图层', synonyms: ['风险图层', '三类安全风险', '风险区', '安全风险'] },
  { term: '设备效率', category: '图层', synonyms: ['设备定位', '设备点位', '设备'] }
]

/** 取词条总数（`GET /api/duner/capabilities` 与词典页都要显示） */

/** 建表语句在 `server/db.mjs` 的 `SCHEMA` 里（全库建表只有一个入口） */

/**
 * 灌种子。**只补缺，不覆盖**（理由见文件头）。
 * @returns {{inserted:number, total:number}}
 */
export function seedDict(db) {
  const ins = db.prepare(
    'INSERT INTO dict_term ("term","category","synonyms","builtin") VALUES (?,?,?,1) ' +
      'ON CONFLICT("term") DO NOTHING'
  )
  let inserted = 0
  for (const t of SEED_TERMS) {
    const info = ins.run(t.term, t.category, JSON.stringify(t.synonyms ?? []))
    if (Number(info.changes) > 0) inserted += 1
  }
  return { inserted, total: countDict(db) }
}

export function countDict(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM dict_term').get().n)
}

/** 读全量词典，`synonyms` 反序列化。损坏的 JSON 当空数组，不让一条坏数据打挂整次对话 */
export function getDict(db) {
  return db
    .prepare('SELECT "term","category","synonyms","builtin" FROM dict_term ORDER BY "id"')
    .all()
    .map((r) => {
      let syn = []
      try {
        const parsed = JSON.parse(r.synonyms)
        if (Array.isArray(parsed)) syn = parsed.filter((s) => typeof s === 'string')
      } catch {
        syn = []
      }
      return { term: r.term, category: r.category, synonyms: syn, builtin: Number(r.builtin) === 1 }
    })
}

/** 新增/覆盖一个词条（管理员接口用）。同名词条直接覆盖同义词 */
export function upsertTerm(db, { term, category = '', synonyms = [] }) {
  if (!term || typeof term !== 'string') throw new Error('标准词不能为空')
  const list = Array.isArray(synonyms) ? synonyms.filter((s) => typeof s === 'string' && s) : []
  db.prepare(
    'INSERT INTO dict_term ("term","category","synonyms","builtin","updatedAt") VALUES (?,?,?,0,?) ' +
      'ON CONFLICT("term") DO UPDATE SET "category"=excluded."category", ' +
      '"synonyms"=excluded."synonyms", "updatedAt"=excluded."updatedAt"'
  ).run(term, category, JSON.stringify(list), new Date().toISOString())
  return { term, category, synonyms: list }
}

export function deleteTerm(db, term) {
  return Number(db.prepare('DELETE FROM dict_term WHERE "term" = ?').run(term).changes) > 0
}

/** 归一化一段文本（读库取词典再交给纯函数） */
export function normalizeWithDb(db, text) {
  return normalize(text, getDict(db))
}
