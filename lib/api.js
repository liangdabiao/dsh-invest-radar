// 面板数据面：/invest-radar 前缀路由（存档只读 + 源管理；抓取/提炼走 agent 对话）。
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getFeed, getDigests, listSources, addSource, removeSource, status, DEFAULT_CONFIG, DATA_DIR } from './store.js'

const BASE = '/invest-radar'
const LAB = fileURLToPath(new URL('../lab/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2',
}

function json(res, statusCode, value) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return false // dsh 0.2.x 宿主已 token 鉴权
  return connection.requestRejection({ headers: req.headers })
}

function safeFile(dir, rel) {
  if (!dir || String(rel).split('/').some((p) => p.startsWith('.'))) return null
  let base
  try { base = realpathSync(dir) } catch { return null }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  const real = realpathSync(file)
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}

function serveFile(req, res, file) {
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('type'), { status: 415 }))
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) return reject(Object.assign(new Error('origin'), { status: 403 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => { size += c.length; if (size > max) req.destroy(); else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch (e) { reject(Object.assign(e, { status: 400 })) } })
    req.on('error', reject)
  })
}

function readVersion() {
  try { return JSON.parse(readFileSync(join(LAB, '..', 'package.json'), 'utf8')).version } catch { return '' }
}

function catalog() {
  const st = status()
  const feed = getFeed()
  const digests = getDigests()
  const failed = feed?.failed_sources || []
  return {
    version: readVersion(),
    dataDir: DATA_DIR,
    has_feed: Boolean(feed),
    generated_at: feed?.generated_at || null,
    recent_days: feed?.recent_days ?? DEFAULT_CONFIG.fetch?.recent_days ?? 7,
    failed_sources: failed,
    stats: {
      total_sources: DEFAULT_CONFIG.sources.length,
      active_sources: listSources().length,
      industries: st.sectors.length,
      items: st.sectors.reduce((n, s) => n + s.items, 0),
      points: st.sectors.reduce((n, s) => n + s.points, 0),
    },
    sectors: st.sectors,
    digest_updated_at: digests.updated_at,
  }
}

export function registerApi(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    async handler(req, res) {
      try {
        const rejection = requestRejection(ctx, req)
        if (typeof rejection === 'number') return json(res, rejection, { error: '未授权' })

        const url = new URL(req.url, 'http://x')
        if (!url.pathname.startsWith(BASE + '/') && url.pathname !== BASE) return json(res, 404, { error: 'not found' })
        const path = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'

        // ---- API（存档只读 + 源配置）----
        if (path === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true })
        if (path === '/api/catalog' && req.method === 'GET') return json(res, 200, catalog())
        if (path === '/api/feed' && req.method === 'GET') {
          const feed = getFeed()
          if (!feed) return json(res, 404, { error: '还没有抓取数据——在对话里让 agent 跑 invest_news(action="fetch")' })
          const sector = url.searchParams.get('sector')
          if (!sector) return json(res, 200, { feed: { generated_at: feed.generated_at, industries: feed.industries.map((i) => ({ key: i.key, name: i.name, accent: i.accent, total: i.items.length })) } })
          const ind = (feed.industries || []).find((x) => x.key === sector)
          if (!ind) return json(res, 404, { error: `没有赛道 ${sector}` })
          const dg = getDigests().sectors?.[sector] || null
          return json(res, 200, { industry: ind, digest: dg })
        }
        if (path === '/api/digests' && req.method === 'GET') return json(res, 200, { digests: getDigests() })
        if (path === '/api/sources' && req.method === 'GET') {
          const feed = getFeed()
          const failed = feed?.failed_sources || []
          const sources = listSources()
          const bySector = {}
          for (const s of sources) {
            if (!bySector[s.hint]) bySector[s.hint] = []
            bySector[s.hint].push({ ...s, failed: failed.some((f) => f.startsWith(`${s.name}:`)) })
          }
          return json(res, 200, { industries: DEFAULT_CONFIG.industries, bySector, failed })
        }
        if (path === '/api/sources/add' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const r = addSource(body)
            return json(res, r.ok ? 200 : 400, r)
          } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
        }
        if (path === '/api/sources/remove' && req.method === 'POST') {
          try {
            const body = await readJson(req)
            const r = removeSource(String(body.name || ''))
            return json(res, r.ok ? 200 : 400, r)
          } catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }) }
        }
        if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' })

        // ---- 静态页面 ----
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' })
        const file = safeFile(LAB, path === '/' ? 'index.html' : path.replace(/^\/+/, ''))
        return file ? serveFile(req, res, file) : json(res, 404, { error: 'not found' })
      } catch (err) {
        json(res, 500, { error: err?.message || '内部错误' })
      }
    },
  })
}
