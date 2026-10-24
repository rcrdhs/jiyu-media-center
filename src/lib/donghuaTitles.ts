/**
 * Donghua (Chinese anime) title data + strict matching for Bilibili / iQIYI lookups.
 *
 *  - TMDB original_name / alternative_titles / translations → Chinese + Latin search keys.
 *  - Normalises traditional → simplified (common title characters), full-width / NFKC,
 *    punctuation and case so 萬古至尊：李雲霄傳 == 万古至尊 李云霄传.
 *  - Strict candidate scoring: title similarity + year + episode count; a weak title
 *    overlap ("Supreme Alchemy" vs "Supreme Commander") never counts as a match.
 */

import { nativeFetchJson } from './nativeHttp'
import { tmdbApiKey } from './tmdbClient'
import { biliLog } from './biliLog'

// Traditional → simplified pairs (one char each), common in donghua titles.
const T2S_PAIRS = '萬万與与傳传雲云劍剑龍龙鬥斗門门師师靈灵陸陆戰战書书錄录記记歸归鳳凤紀纪華华國国獸兽無无極极縱纵橫横馬马遊游幾几個个來来時时間间東东長长寶宝屍尸葉叶蕭萧張张陳陈楊杨劉刘吳吴趙赵黃黄鄭郑謝谢羅罗風风飛飞鳥鸟線线開开關关學学會会這这為为後后說说話话動动畫画頭头從从輪轮轉转進进運运遠远還还邊边億亿隱隐陰阴陽阳際际雙双難难雜杂雞鸡電电靜静須须順顺領领顯显驚惊體体髮发鬆松麗丽齊齐龜龟亂乱爭争們们僅仅優优兒儿內内兩两劃划勞劳勢势區区協协單单衛卫厲厉參参號号嗎吗嚴严圓圆圖图團团夢梦夠够奪夺奮奋婦妇嬰婴寧宁實实審审寫写將将專专尋寻對对導导層层屬属嶺岭島岛帥帅幣币幫帮廣广廢废彈弹復复徹彻恆恒惡恶愛爱態态憶忆應应戀恋戲戏戶户執执擊击擇择據据攝摄數数斷断曉晓條条楓枫構构槍枪樂乐標标樣样機机檢检權权歡欢歲岁歷历殺杀殘残氣气決决沒没滅灭淚泪淺浅渾浑測测溫温滄沧滿满漢汉潛潜濟济灣湾災灾煉炼煙烟熱热燈灯爾尔牽牵獄狱獨独獵猎現现環环產产異异療疗盡尽盤盘眾众確确碼码禮礼禍祸種种穩稳窮穷競竞筆笔節节簡简糧粮紅红約约級级純纯紙纸細细終终組组結结絕绝絲丝經经綠绿維维緣缘練练縣县總总繼继續续義义習习聖圣聞闻聲声職职聽听腦脑膽胆臨临興兴舊旧莊庄蒼苍蓋盖蘇苏處处蟲虫術术衝冲補补裝装製制覺觉親亲觀观計计訂订討讨訓训許许設设訪访證证詩诗試试誅诛認认語语誤误誰谁調调談谈請请諸诸謀谋識识護护讀读變变豐丰貓猫負负財财貪贪貴贵買买費费賊贼資资賞赏賢贤質质贏赢趕赶跡迹踐践蹤踪車车軍军軒轩輕轻載载輝辉辦办農农迴回連连週周過过達达違违遙遥適适選选遺遗鄉乡醫医釋释鈴铃銀银鋒锋錢钱錯错鍊炼鎮镇鏡镜鐵铁閃闪閉闭閣阁闖闯隊队階阶險险隨随雖虽霧雾韓韩頁页頂顶項项預预頓顿題题顏颜願愿類类顧顾飄飘餘余館馆駕驾騎骑騰腾驅驱驗验髒脏鬧闹魚鱼鮮鲜鳴鸣鴻鸿鷹鹰麼么黨党齡龄龐庞傑杰鎖锁鑄铸闕阙瀾澜蠻蛮屆届揚扬塵尘壞坏壓压壽寿奧奥嫵妩孫孙宮宫寵宠岡冈巔巅廟庙廳厅彎弯徑径恥耻悅悦慘惨慶庆憐怜懷怀懸悬拋抛掃扫擁拥擋挡敗败敵敌暫暂曆历樓楼橋桥歐欧毀毁涼凉淵渊湯汤滾滚潔洁濁浊瀟潇灑洒爐炉犧牺狀状猶犹獅狮璽玺畢毕瘋疯癡痴盜盗礦矿祿禄禪禅稱称穀谷竊窃簽签紛纷絡络網网緊紧編编縛缚縮缩織织繞绕罰罚聯联脫脱臉脸艦舰艱艰藍蓝藝艺藥药蘭兰衆众裡里誘诱謎谜譜谱豬猪賀贺賭赌躍跃軟软輔辅輩辈辭辞邁迈郵邮鋼钢錦锦闊阔陣阵隸隶韻韵響响頻频顆颗飯饭飲饮騙骗驕骄鬱郁魯鲁麥麦齒齿濤涛瑣琐嶽岳鍾钟鐘钟誕诞齋斋聶聂蕓芸韋韦賈贾錫锡顥颢闆板夥伙禦御籤签鑑鉴鑒鉴魘魇蝦虾鴉鸦鵬鹏鶴鹤鸞鸾黴霉獻献營营戩戬壇坛壯壮姦奸屜屉擬拟擴扩撐撑撫抚曠旷櫻樱殤殇氫氢潤润澤泽瀧泷燒烧燦灿煥焕犢犊猙狰瑪玛瓊琼甕瓮疊叠痺痹瞭了硯砚禱祷穌稣籠笼紋纹紮扎絃弦綺绮縷缕繡绣翺翱艷艳蘊蕴蘿萝蠱蛊襲袭覓觅訣诀詭诡諾诺謊谎譯译讚赞贊赞軀躯轟轰遜逊邏逻醜丑鉤钩銳锐錘锤鍛锻鎧铠鑽钻陝陕隕陨雛雏靂雳頌颂颯飒馭驭駭骇驟骤髏髅鱗鳞鷲鹫龕龛'

let t2sMap: Map<string, string> | null = null
function t2s(): Map<string, string> {
  if (t2sMap) return t2sMap
  const m = new Map<string, string>()
  const chars = Array.from(T2S_PAIRS)
  for (let i = 0; i + 1 < chars.length; i += 2) m.set(chars[i], chars[i + 1])
  t2sMap = m
  return m
}

export function toSimplified(s: string): string {
  const m = t2s()
  let out = ''
  for (const ch of String(s || '')) out += m.get(ch) ?? ch
  return out
}

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/
const KANA_HANGUL_RE = /[\u3040-\u30ff\uac00-\ud7af]/

export function hasCjk(s: string): boolean {
  return CJK_RE.test(String(s || ''))
}

/** True for Chinese (Han, no kana / hangul) text. */
export function isChineseText(s: string): boolean {
  const t = String(s || '')
  return CJK_RE.test(t) && !KANA_HANGUL_RE.test(t)
}

const CN_NUM: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
}

function parseCnNumber(s: string): number {
  if (/^\d+$/.test(s)) return Number(s)
  if (s === '十') return 10
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s)
  if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0)
  return CN_NUM[s] ?? 0
}

const SEASON_PATTERNS: RegExp[] = [
  /第\s*([0-9一二两三四五六七八九十]+)\s*[季部]/,
  /\bseason\s*(\d{1,2})\b/i,
  /\bs(\d{1,2})\b/i,
  /\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i,
]

/** Season number written in a title (第二季 / Season 2 / S2), or 0 when none. */
export function seasonMarker(title: string): number {
  const t = toSimplified(String(title || '').normalize('NFKC'))
  for (const re of SEASON_PATTERNS) {
    const m = re.exec(t)
    if (m) {
      const n = parseCnNumber(m[1])
      if (n > 0) return n
    }
  }
  return 0
}

function stripSeasonMarkers(title: string): string {
  let t = toSimplified(String(title || '').normalize('NFKC'))
  for (const re of SEASON_PATTERNS) t = t.replace(new RegExp(re.source, re.flags + 'g'), ' ')
  return t
}

/** Comparison key: NFKC, simplified, lowercase, letters/digits only. */
export function normalizeTitleKey(title: string): string {
  return toSimplified(String(title || '').normalize('NFKC'))
    .toLowerCase()
    .replace(/[\u2019']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

const LATIN_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'in', 'to', 'no', 'wo', 'de', 'la', 'le', 'season', 'part',
  'episode', 'ep', 'anime', 'donghua',
])

function latinTokens(title: string): Set<string> {
  const t = toSimplified(String(title || '').normalize('NFKC'))
    .toLowerCase()
    .replace(/[\u2019']/g, '')
  const out = new Set<string>()
  for (const w of t.split(/[^\p{L}\p{N}]+/u)) {
    if (!w || LATIN_STOPWORDS.has(w)) continue
    out.add(w)
  }
  return out
}

/** 0..1 — how well two titles match (season markers ignored; scored separately). */
export function donghuaTitleSimilarity(a: string, b: string): number {
  const sa = stripSeasonMarkers(a)
  const sb = stripSeasonMarkers(b)
  const ka = normalizeTitleKey(sa)
  const kb = normalizeTitleKey(sb)
  if (!ka || !kb) return 0
  if (ka === kb) return 1
  if (hasCjk(ka) && hasCjk(kb)) {
    const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka]
    if (short.length >= 3 && long.includes(short)) {
      return Math.min(0.95, 0.6 + 0.4 * (short.length / long.length))
    }
    // Character overlap (order-insensitive) — weak signal only.
    const setA = new Set(Array.from(ka))
    let hit = 0
    for (const ch of Array.from(kb)) if (setA.has(ch)) hit += 1
    return Math.min(0.55, (hit / Math.max(ka.length, kb.length)) * 0.55)
  }
  const ta = latinTokens(sa)
  const tb = latinTokens(sb)
  if (ta.size === 0 || tb.size === 0) return 0
  let hit = 0
  for (const w of tb) if (ta.has(w)) hit += 1
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta]
  if (hit === small.size && small.size >= 2) return 0.6 + 0.4 * (small.size / big.size)
  return hit / Math.max(ta.size, tb.size)
}

export type DonghuaMatchQuery = {
  titles: string[]
  year?: number
  episodeCount?: number
  season?: number
}

export type DonghuaCandidate = {
  title: string
  year?: number
  episodeCount?: number
}

export type DonghuaMatchScore = {
  score: number
  titleSim: number
  yearMatch: boolean
  yearBad: boolean
  epMatch: boolean
  strong: boolean
  reason: string
}

/** Strict match: needs a strong title, or a decent title backed by year (+ episode count). */
export function scoreDonghuaCandidate(q: DonghuaMatchQuery, c: DonghuaCandidate): DonghuaMatchScore {
  let titleSim = 0
  for (const t of q.titles) {
    if (!t) continue
    titleSim = Math.max(titleSim, donghuaTitleSimilarity(t, c.title))
  }
  const wantSeason = Math.max(1, Math.floor(q.season || 1))
  const marker = seasonMarker(c.title)
  if (marker > 0 && marker !== wantSeason) {
    return {
      score: -100, titleSim, yearMatch: false, yearBad: false, epMatch: false, strong: false,
      reason: `season marker ${marker} ≠ ${wantSeason}`,
    }
  }
  const qy = q.year && q.year > 1900 ? q.year : 0
  const cy = c.year && c.year > 1900 ? c.year : 0
  const yearMatch = !!qy && !!cy && Math.abs(qy - cy) <= 1
  const yearBad = !!qy && !!cy && Math.abs(qy - cy) > 2
  const qe = q.episodeCount && q.episodeCount > 0 ? q.episodeCount : 0
  const ce = c.episodeCount && c.episodeCount > 0 ? c.episodeCount : 0
  const epRatio = qe && ce ? Math.min(qe, ce) / Math.max(qe, ce) : -1
  const epMatch = epRatio >= 0.8 || (qe > 0 && ce > 0 && Math.abs(qe - ce) <= 3)
  let score = titleSim * 100
  if (yearMatch) score += 10
  if (yearBad) score -= 30
  if (epMatch) score += 10
  else if (epRatio >= 0 && epRatio < 0.3) score -= 15
  if (wantSeason > 1 && marker === 0) score -= 8
  let strong = false
  let reason = ''
  if (yearBad) reason = `year ${cy} vs ${qy}`
  else if (titleSim >= 0.9) strong = true
  else if (titleSim >= 0.75 && yearMatch) strong = true
  else if (titleSim >= 0.6 && yearMatch && epMatch) strong = true
  else reason = `weak title ${titleSim.toFixed(2)}`
  if (strong && wantSeason > 1 && marker === 0 && titleSim < 0.9) {
    strong = false
    reason = 'no season marker'
  }
  return { score, titleSim, yearMatch, yearBad, epMatch, strong, reason: strong ? 'strong' : reason }
}

// ── TMDB info ────────────────────────────────────────────────────────────────

export type DonghuaTitleInfo = {
  tmdbId: string
  name: string
  originalName: string
  originalLanguage: string
  /** Simplified Chinese titles (best first). */
  zhTitles: string[]
  /** English / romanised titles (best first). */
  latinTitles: string[]
  year: number
  /** Episodes in the requested TMDB season (or whole show when unknown). */
  episodeCount: number
  totalEpisodes: number
  seasonEpisodeCounts: Record<number, number>
  networks: string[]
  isChinese: boolean
}

type TmdbTvDetail = {
  id?: number
  name?: string
  original_name?: string
  original_language?: string
  origin_country?: string[]
  first_air_date?: string
  number_of_episodes?: number
  seasons?: Array<{ season_number?: number; episode_count?: number }>
  networks?: Array<{ name?: string }>
  alternative_titles?: { results?: Array<{ iso_3166_1?: string; title?: string }> }
  translations?: {
    translations?: Array<{ iso_639_1?: string; iso_3166_1?: string; data?: { name?: string } }>
  }
}

const TMDB_CACHE_PREFIX = 'jiyu.donghuaTmdb.v1.'
const TMDB_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000
const memCache = new Map<string, { at: number; info: DonghuaTitleInfo }>()

function pushUnique(list: string[], value: string | undefined): void {
  const v = String(value || '').replace(/\./g, ' ').replace(/\s+/g, ' ').trim()
  if (!v) return
  const key = normalizeTitleKey(v)
  if (!key || list.some((x) => normalizeTitleKey(x) === key)) return
  list.push(v)
}

export function donghuaInfoFromTmdb(d: TmdbTvDetail): DonghuaTitleInfo {
  const zh: string[] = []
  const latin: string[] = []
  const orig = String(d.original_name || '')
  const lang = String(d.original_language || '')
  if (isChineseText(orig)) pushUnique(zh, toSimplified(orig.normalize('NFKC')))
  for (const tr of d.translations?.translations || []) {
    const n = String(tr.data?.name || '')
    if (tr.iso_639_1 === 'zh' && isChineseText(n)) pushUnique(zh, toSimplified(n.normalize('NFKC')))
  }
  for (const alt of d.alternative_titles?.results || []) {
    const t = String(alt.title || '')
    if (isChineseText(t)) pushUnique(zh, toSimplified(t.normalize('NFKC')))
  }
  pushUnique(latin, d.name)
  for (const tr of d.translations?.translations || []) {
    if (tr.iso_639_1 === 'en') pushUnique(latin, tr.data?.name)
  }
  for (const alt of d.alternative_titles?.results || []) {
    const t = String(alt.title || '')
    // Latin-script aliases only (pinyin / English); skip Vietnamese, Thai, Cyrillic, etc.
    if (/^[\x20-\x7e]+$/.test(t)) pushUnique(latin, t)
  }
  // "The Eternal Supreme, Li Yunxiao" → also try "The Eternal Supreme".
  const head = String(d.name || '').split(/[:,：]/)[0]?.trim()
  if (head && head.length >= 6) pushUnique(latin, head)
  const seasonEpisodeCounts: Record<number, number> = {}
  for (const s of d.seasons || []) {
    const n = Number(s.season_number)
    if (Number.isFinite(n) && n > 0) seasonEpisodeCounts[n] = Number(s.episode_count) || 0
  }
  const countries = (d.origin_country || []).map((c) => String(c).toUpperCase())
  const isChinese =
    lang === 'zh' || lang === 'cn' || countries.includes('CN') || (zh.length > 0 && !KANA_HANGUL_RE.test(orig))
  return {
    tmdbId: String(d.id || ''),
    name: String(d.name || ''),
    originalName: orig,
    originalLanguage: lang,
    zhTitles: zh,
    latinTitles: latin,
    year: Number(String(d.first_air_date || '').slice(0, 4)) || 0,
    episodeCount: Number(d.number_of_episodes) || 0,
    totalEpisodes: Number(d.number_of_episodes) || 0,
    seasonEpisodeCounts,
    networks: (d.networks || []).map((n) => String(n.name || '')).filter(Boolean),
    isChinese,
  }
}

function readCache(id: string): DonghuaTitleInfo | null {
  const mem = memCache.get(id)
  if (mem && Date.now() - mem.at < TMDB_CACHE_TTL_MS) return mem.info
  try {
    const raw = globalThis.localStorage?.getItem(TMDB_CACHE_PREFIX + id)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { at?: number; info?: DonghuaTitleInfo }
    if (!parsed.info || !parsed.at || Date.now() - parsed.at > TMDB_CACHE_TTL_MS) return null
    memCache.set(id, { at: parsed.at, info: parsed.info })
    return parsed.info
  } catch {
    return null
  }
}

function writeCache(id: string, info: DonghuaTitleInfo): void {
  const at = Date.now()
  memCache.set(id, { at, info })
  try {
    globalThis.localStorage?.setItem(TMDB_CACHE_PREFIX + id, JSON.stringify({ at, info }))
  } catch {
    /* quota */
  }
}

/**
 * TMDB show → Chinese / Latin titles, year, episode counts. Uses the bundle's
 * TMDB_API_KEY (same as the Android TMDB shelves); null when unavailable.
 */
export async function fetchDonghuaTitleInfo(
  tmdbId: string | number | undefined,
  opts: { season?: number; apiKey?: string } = {},
): Promise<DonghuaTitleInfo | null> {
  const id = String(tmdbId ?? '').trim()
  if (!/^\d+$/.test(id)) return null
  const withSeason = (info: DonghuaTitleInfo): DonghuaTitleInfo => {
    const s = Math.max(1, Math.floor(opts.season || 1))
    const n = info.seasonEpisodeCounts?.[s]
    return n ? { ...info, episodeCount: n } : info
  }
  const cached = readCache(id)
  if (cached) return withSeason(cached)
  let key = opts.apiKey || ''
  if (!key) {
    try {
      key = tmdbApiKey()
    } catch {
      key = ''
    }
  }
  if (!key) {
    biliLog('tmdb.skip', { tmdbId: id, reason: 'no TMDB key in bundle' })
    return null
  }
  const url =
    `https://api.themoviedb.org/3/tv/${encodeURIComponent(id)}?api_key=${encodeURIComponent(key)}` +
    '&language=en-US&append_to_response=alternative_titles,translations'
  const r = await nativeFetchJson<TmdbTvDetail>(url)
  if (!r.ok || !r.data?.id) {
    biliLog('tmdb.fail', { tmdbId: id, error: r.error })
    return null
  }
  const info = donghuaInfoFromTmdb(r.data)
  writeCache(id, info)
  biliLog('tmdb.info', {
    tmdbId: id, zh: info.zhTitles, latin: info.latinTitles.slice(0, 4), year: info.year,
    eps: info.totalEpisodes, chinese: info.isChinese, networks: info.networks,
  })
  return withSeason(info)
}
