// 冒烟测试（离线）：面板 API 全链路（catalog/feed/sources 增删）+ 工具 execute 直调（fixture 数据）。
// 运行：node scripts/smoke.mjs     真实网络抓取另见 scripts/live.mjs
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-invest-radar-smoke-'))
process.env.DSH_HOME = tmp

let failed = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
  if (!cond) failed++
}

// ── 假 RSS 服务器（本地 http，验证 fetcher 网络层 + 解析层端到端）────────
import http from 'node:http'
const rf = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600 * 1000).toUTCString()
const iso = (hoursAgo) => new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString()
const RSS_A = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title><![CDATA[OpenAI 发布新模型 o5]]></title><link>https://openai.com/news/o5?utm_source=rss</link><pubDate>${rf(2)}</pubDate><description>&lt;p&gt;推理能力大幅提升&lt;/p&gt;</description></item>
<item><title>OpenAI 发布新模型 o5</title><link>https://mirror.com/o5</link><pubDate>${rf(3)}</pubDate></item>
<item><title>加密货币赌场新闻</title><link>https://spam.com/1</link></item>
</channel></rss>`
const RSS_B = `<?xml version="1.0"?><rss version="2.0"><channel>
<item><title>台积电月度营收创新高</title><link>https://tsmc.com/news/1</link><pubDate>${iso(4)}</pubDate></item>
</channel></rss>`
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/xml' })
  res.end(req.url.includes('a-rss') ? RSS_A : RSS_B)
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const port = srv.address().port

// ── 工具直调（fetch → list → digest_save → status → sources）───────────
// 离线确定性：先把内置 106 源全部移除、只指向本地 fixture 服务器
const { DEFAULT_CONFIG } = await import('../lib/store.js')
const { mkdirSync } = await import('node:fs')
const userFile = join(tmp, 'invest-radar', 'sources.user.json') // 与 store 的 DATA_DIR 布局一致
mkdirSync(join(tmp, 'invest-radar'), { recursive: true })
writeFileSync(userFile, JSON.stringify({
  remove: DEFAULT_CONFIG.sources.map((s) => s.name),
  add: [
    { name: 'FixA', hint: 'ai', type: 'rss', url: `http://127.0.0.1:${port}/a-rss` },
    { name: 'FixB', hint: 'semi', type: 'rss', url: `http://127.0.0.1:${port}/b-rss` },
  ],
}, null, 2))

const { investNewsTool } = await import('../src/host.js')
const cfg = { recentDays: 30, timeout: 5000, perSource: 5, concurrency: 5 }
const call = (args) => investNewsTool.execute(args, cfg)

{
  const r = await call({ action: 'fetch' })
  check('fetch（fixture 两源）', r.ok === true && r.data.includes('AI / 大模型：1 条'), r.summary.slice(0, 60))
}
{
  const r = await call({ action: 'status' })
  check('status 有数据', r.ok === true && r.data.includes('AI / 大模型'))
}
{
  const r = await call({ action: 'list', sectors: 'ai', limit: 5 })
  check('list 单赛道（转载去重后 1 条）', r.data.includes('OpenAI 发布新模型 o5') && !r.data.includes('mirror.com'), r.data.split('\n').length + ' 行')
  check('list 跟踪参数已剥', r.data.includes('https://openai.com/news/o5') && !r.data.includes('utm_source'))
  check('list 红线过滤生效', !r.data.includes('加密货币'))
}
{
  const r = await call({
    action: 'digest_save',
    digestJson: JSON.stringify({
      key: 'ai',
      points: [{ t: 'OpenAI 发布 o5，推理能力大幅提升', url: 'https://openai.com/news/o5' }],
      items: [{ url: 'https://openai.com/news/o5', zh: 'OpenAI 发布新模型 o5' }],
    }),
  })
  check('digest_save 存档', r.ok === true && r.summary.includes('要点 1'))
}
{
  let threw = false
  try { await call({ action: 'digest_save', digestJson: JSON.stringify({ key: 'bad', points: [] }) }) } catch { threw = true }
  check('digest_save 非法赛道抛错', threw === true)
}
{
  const r = await call({ action: 'sources', sourceAction: 'list' })
  check('sources list 含 fixture', r.data.includes('FixA') && r.data.includes('FixB'))
}
{
  const r = await call({ action: 'sources', sourceAction: 'add', name: '本地测试源', url: `http://127.0.0.1:${port}/b-rss2`, sector: 'auto' })
  check('sources add', r.ok === true)
  const r2 = await call({ action: 'fetch', sectors: 'auto' })
  check('加源后 fetch 生效', r2.ok === true && r2.summary.includes('成功'), r2.summary.slice(0, 60))
  const r3 = await call({ action: 'sources', sourceAction: 'remove', name: '本地测试源' })
  check('sources remove', r3.ok === true)
}
{
  const r = await call({ action: 'fetch', sectors: '不存在的赛道' })
  check('非法赛道名回退全部（fixture 生效）', r.ok === true && r.data.includes('AI / 大模型：1 条'))
}

// ── 面板 API（真 http 走 registerApi）──────────────────────────────────
srv.close()
const { registerApi } = await import('../lib/api.js')
const routes = {}
registerApi({ get: () => undefined, webServer: { register: (r) => { routes[r.path] = r.handler } } })
const handler = routes['/invest-radar']
function mockRes() {
  const res = new Writable({ write(c, _e, cb) { res.body += c.toString(); cb() } })
  res.body = ''; res.statusCode = 0; res.headers = {}
  res.writeHead = (s, h) => { res.statusCode = s; Object.assign(res.headers, h || {}) }
  return res
}
function mockReq(url, { method = 'GET', body = null } = {}) {
  const req = new EventEmitter()
  req.url = url.startsWith('/invest-radar') ? url : '/invest-radar' + url
  req.method = method
  req.headers = { host: 'localhost', 'content-type': 'application/json' }
  if (body != null) setImmediate(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  return req
}
const callApi = (path, opts) => new Promise((resolve) => {
  const res = mockRes()
  res.on('finish', () => resolve(res))
  handler(mockReq(path, opts), res)
})
{
  const html = await callApi('/')
  check('静态看板页', html.statusCode === 200 && html.body.includes('投资雷达'))
  const cat = JSON.parse((await callApi('/api/catalog')).body)
  check('catalog 统计', cat.has_feed === true && cat.stats.items > 0 && cat.stats.points >= 1, `items=${cat.stats.items} points=${cat.stats.points}`)
  const feed = JSON.parse((await callApi('/api/feed?sector=ai')).body)
  check('feed 单赛道含要点', feed.industry.items.length > 0 && feed.digest.points.length >= 1)
  const nf = await callApi('/api/feed?sector=nope')
  check('feed 404', nf.statusCode === 404)
  const add = JSON.parse((await callApi('/api/sources/add', { method: 'POST', body: { name: 'API测试源', url: 'https://api.example/rss', sector: 'ai' } })).body)
  check('API 加源', add.ok === true)
  const rm = JSON.parse((await callApi('/api/sources/remove', { method: 'POST', body: { name: 'API测试源' } })).body)
  check('API 删源', rm.ok === true)
  const trav = await callApi(encodeURI('/invest-radar/../package.json').replace(/\.\./g, '%2e%2e'))
  check('路径穿越被拒', trav.statusCode === 404)
}

rmSync(tmp, { recursive: true, force: true })
console.log(failed ? `\n${failed} 项失败` : '\n冒烟全部通过')
process.exit(failed ? 1 : 0)
