// 抓取引擎：原项目 scripts/fetch.py 的全量 Node 移植（MIT，simonlin1212/investment-news）。
// 去重的每个细节都是真实 issue 打磨出来的，别"简化"：
//   - URL 只剥无歧义跟踪参数（?p=123 是文章 id，剥了就静默丢文章）
//   - 标题去重带 48h 窗口（跨周复用的"每周综述"栏目不能误杀）
//   - 被丢弃的条目也要登记 key（链式转载传递性）；保留条目刷新基准时间（丢弃条目 setdefault）
//   - 缺发布时间（ts=0）的条目不做标题去重（判错删掉的代价 > 多显示一条）
import http from 'node:http'
import https from 'node:https'
import { TLSSocket } from 'node:tls'

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const BEIJING_OFFSET_MS = 8 * 3600 * 1000
// 只列无歧义的跟踪参数；source/from/ref/share 这类通用词在某些站点是文章标识的一部分
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'spm', 'share_token', 'fbclid', 'gclid', 'msclkid', 'mc_cid', 'mc_eid', '_hsenc', '_hsmi',
])
const DUP_TITLE_WINDOW_S = 48 * 3600

// ── 归一化 ─────────────────────────────────────────────────────────────
export function normalizeUrl(url) {
  if (!url) return ''
  const raw = String(url).trim()
  try {
    const u = new URL(raw)
    const kept = []
    for (const [k, v] of u.searchParams) {
      if (!TRACKING_PARAMS.has(k.toLowerCase())) kept.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    }
    const query = kept.join('&')
    // 与 Python urlsplit+urlencode 对齐：value 原样拼接（不再编码 %XX 以外的字符）
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${query ? '?' + query : ''}`
  } catch {
    return raw.toLowerCase()
  }
}

// Python 的 \w 是 unicode 语义（中文是 \w 保留）；JS \w 是 ASCII，必须用 \p{L}\p{N}
export function normalizeTitle(title) {
  return String(title || '').toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '')
}

export function dedup(items) {
  const seenUrls = new Set()
  const seenTitles = new Map()
  const out = []
  for (const it of items) {
    const urlKey = normalizeUrl(it.url || '')
    const titleKey = normalizeTitle(it.title || '')
    const ts = it.ts || 0
    const dupByUrl = Boolean(urlKey) && seenUrls.has(urlKey)
    const prevTs = titleKey ? seenTitles.get(titleKey) : undefined
    const dupByTitle = prevTs !== undefined && Boolean(ts) && Boolean(prevTs) && Math.abs(prevTs - ts) <= DUP_TITLE_WINDOW_S
    if (urlKey) seenUrls.add(urlKey)
    if (dupByUrl || dupByTitle) {
      if (titleKey && ts) seenTitles.set(titleKey, seenTitles.get(titleKey) ?? ts) // 丢弃分支 setdefault
      continue
    }
    if (titleKey && ts) seenTitles.set(titleKey, ts) // 保留分支刷新基准时间
    out.push(it)
  }
  return out
}

// ── 时间 ───────────────────────────────────────────────────────────────
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
const TZ_OFFSETS = { GMT: 0, UTC: 0, UT: 0, Z: 0, EST: -5 * 60, EDT: -4 * 60, CST: -6 * 60, CDT: -5 * 60, MST: -7 * 60, MDT: -6 * 60, PST: -8 * 60, PDT: -7 * 60, BST: 1 * 60, CET: 1 * 60, CEST: 2 * 60, JST: 9 * 60, KST: 9 * 60, IST: 5.5 * 60 }
const RFC2822_RE = /^(?:[A-Za-z]{3,9},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s+([A-Za-z]+|[+-]\d{4})?$/

// RFC2822 迷你解析（V8 对 "…GMT" 的 legacy 解析不可靠，自己算偏移）
function parseRfc2822(str) {
  const m = str.match(RFC2822_RE)
  if (!m) return NaN
  const day = Number(m[1])
  const mon = MONTHS[m[2]]
  if (mon === undefined) return NaN
  let year = Number(m[3])
  if (year < 100) year += 2000
  const hh = Number(m[4]), mi = Number(m[5]), ss = m[6] ? Number(m[6]) : 0
  let offsetMin = 0
  const tz = m[7]
  if (tz) {
    if (/^[+-]/.test(tz)) offsetMin = (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3)))
    else offsetMin = TZ_OFFSETS[tz] ?? 0
  }
  return Date.UTC(year, mon, day, hh, mi, ss) - offsetMin * 60000
}

export function parseDate(s) {
  if (!s) return null
  const str = String(s).trim()
  if (!str) return null
  // ISO / naive 形态先自处理：V8 对 "2025-06-02 08:00"（空格形态）会按【本地时区】解析，
  // 与 Python「naive 补 UTC」语义不同，必须在 Date.parse 之前补 Z。
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(str)) {
    let iso = str.replace(' ', 'T')
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(iso)) iso += 'Z'
    const t = Date.parse(iso)
    if (!Number.isNaN(t)) return new Date(t)
  }
  // RFC2822 形态（"Mon, 02 Jun …"）优先自解析：V8 的 legacy 解析同样会按本地时区算错
  let t = NaN
  if (/^[A-Za-z]{3,9},/.test(str)) t = parseRfc2822(str)
  if (Number.isNaN(t)) t = Date.parse(str)
  if (Number.isNaN(t)) t = parseRfc2822(str)
  if (Number.isNaN(t)) return null
  return new Date(t)
}

export function beijingTime(ts) {
  const d = new Date(ts + BEIJING_OFFSET_MS)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}
export function beijingNow() {
  const d = new Date(Date.now() + BEIJING_OFFSET_MS)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

// ── 网络层：支持 HTTP(S) 代理（CONNECT 隧道），零依赖 ──────────────────
function connectTunnel(proxyUrl, targetHost, targetPort, timeout) {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl)
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { host: `${targetHost}:${targetPort}` },
      timeout,
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`proxy CONNECT ${res.statusCode}`)) }
      else resolve(socket)
    })
    req.on('timeout', () => { req.destroy(new Error('proxy connect timeout')) })
    req.on('error', reject)
    req.end()
  })
}

export function httpGet(url, { timeout = 30000, proxyUrl = '' } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === 'https:'
    const finish = (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => { size += c.length; if (size > 3 * 1024 * 1024) res.destroy() ; else chunks.push(c) })
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    }
    const onError = (e) => reject(Object.assign(e, { url }))
    try {
      if (proxyUrl) {
        const port = u.port || (isHttps ? 443 : 80)
        if (isHttps) {
          connectTunnel(proxyUrl, u.hostname, port, timeout).then((socket) => {
            const req = https.request({
              hostname: u.hostname, port, path: u.pathname + u.search, method: 'GET',
              headers: { 'user-agent': UA, accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' },
              socket, agent: false, timeout,
            }, finish)
            req.on('timeout', () => req.destroy(new Error('timeout')))
            req.on('error', onError)
            req.end()
          }, onError)
        } else {
          const proxy = new URL(proxyUrl)
          const req = http.request({
            host: proxy.hostname, port: Number(proxy.port) || 80, path: url, method: 'GET',
            headers: { 'user-agent': UA, host: u.host, accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' },
            timeout,
          }, finish)
          req.on('timeout', () => req.destroy(new Error('timeout')))
          req.on('error', onError)
          req.end()
        }
      } else {
        const lib = isHttps ? https : http
        const req = lib.get(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' }, timeout }, finish)
        req.on('timeout', () => req.destroy(new Error('timeout')))
        req.on('error', onError)
      }
    } catch (e) { onError(e) }
  })
}

// ── RSS/Atom 解析（手解，零依赖；CDATA/实体按 Python ElementTree 语义处理）──
const decodeXml = (s) => String(s || '')
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const stripCdata = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

// 取 block 里第一个 <name>…</name> 或 <name …/> 的内容（含属性形态）
function extractField(block, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>|<${name}(?:\\s[^>]*)?/>`, 'i')
    const m = block.match(re)
    if (!m) continue
    if (m[1] !== undefined) return stripCdata(m[1]).trim()
    return '' // 自闭合（如 <link href=…/> 无文本）
  }
  return ''
}

function extractLink(block) {
  // Atom：<link href="…"/>；RSS：<link>text</link>。取第一个 link（与原实现一致）
  const href = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i)
  if (href) return decodeXml(href[1].trim())
  const m = block.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/i)
  return m ? decodeXml(stripCdata(m[1]).trim()) : ''
}

export function parseFeed(xml, src, { perSource = 5, cutoffMs = 0, redline = [] } = {}) {
  const out = []
  const items = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/g)]
  for (const [, , block] of items) {
    if (out.length >= perSource) break
    const title = decodeXml(stripCdata(extractField(block, ['title'])))
    if (!title) continue
    const url = extractLink(block)
    const rawTime = extractField(block, ['pubDate', 'published', 'updated', 'date'])
    const summaryRaw = extractField(block, ['description', 'summary', 'content'])
    const summary = stripHtml(decodeXml(stripCdata(summaryRaw))).slice(0, 160)
    const blob = (title + ' ' + summary).toLowerCase()
    if (redline.some((k) => blob.includes(k))) continue
    const d = { title, url: normalizeUrl(url) || url, time: '—', ts: 0, summary, source: src.name }
    const dt = parseDate(rawTime)
    if (dt) {
      if (cutoffMs && dt.getTime() < cutoffMs) continue
      d.time = beijingTime(dt.getTime())
      d.ts = Math.floor(dt.getTime() / 1000)
    }
    out.push(d)
  }
  return out
}

// ── 单源抓取（失败返回 null，区别于 []=成功但近 N 天无新内容）──────────
export async function fetchSource(src, { timeout = 30000, proxyUrl = '', perSource = 5, cutoffMs = 0, redline = [] } = {}) {
  try {
    const { status, body } = await httpGet(src.url, { timeout, proxyUrl })
    if (status !== 200) throw new Error(`HTTP ${status}`)
    return parseFeed(body.toString('utf8'), src, { perSource, cutoffMs, redline })
  } catch (e) {
    return { error: `${src.name || '?'}: ${String(e.message || e).slice(0, 80)}` }
  }
}

// 并发池
async function runPool(tasks, limit) {
  const results = new Array(tasks.length)
  let next = 0
  async function worker() {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

// ── 主入口：按赛道分组抓取 → 排序 → 去重 ─────────────────────────────
export async function fetchAll({ industries, sources }, cfg = {}) {
  const {
    recentDays = 7, perSource = 5, timeout = 30000, proxyUrl = '', concurrency = 40,
    redline = [],
  } = cfg
  const cutoffMs = recentDays > 0 ? Date.now() - recentDays * 86400 * 1000 : 0
  const redlineLower = redline.map((k) => String(k).toLowerCase())
  const byHint = new Map()
  for (const s of sources) {
    if (!byHint.has(s.hint)) byHint.set(s.hint, [])
    byHint.get(s.hint).push(s)
  }

  const boards = industries.map((ind) => ({
    key: ind.key, name: ind.name, accent: ind.accent,
    total: (byHint.get(ind.key) || []).length, items: [],
  }))
  const tasks = []
  const taskBoard = []
  boards.forEach((board, i) => {
    for (const src of byHint.get(board.key) || []) { tasks.push(() => fetchSource(src, { timeout, proxyUrl, perSource, cutoffMs, redline: redlineLower })); taskBoard.push(i) }
  })
  const results = await runPool(tasks, concurrency)

  const failedSources = []
  results.forEach((r, i) => {
    if (!r) return
    if (r.error) { failedSources.push(r.error); return }
    boards[taskBoard[i]].items.push(...r)
  })
  let dupRemoved = 0
  for (const board of boards) {
    board.items.sort((a, b) => (b.ts || 0) - (a.ts || 0))
    const before = board.items.length
    board.items = dedup(board.items)
    dupRemoved += before - board.items.length
  }
  return {
    generated_at: beijingNow(),
    recent_days: recentDays,
    industries: boards,
    stats: { industries: boards.length, total_sources: sources.length },
    _failed: failedSources,
    _dup_removed: dupRemoved,
  }
}
