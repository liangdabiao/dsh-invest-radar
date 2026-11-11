// 定时抓取测试：schedule.json 存取、GET/POST /api/schedule、runNow 触发宿主抓取。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'invest-schedule-'))
process.env.DSH_HOME = dataDir

const { getSchedule, saveSchedule } = await import('../lib/store.js')
const { registerApi } = await import('../lib/api.js')

const captured = []
registerApi({ get: () => null, webServer: { register: (x) => captured.push(x) } }, { config: {} })
const handler = captured[0].handler

function mockReq(method, url, headers = {}, body) {
  const chunks = body ? [Buffer.from(JSON.stringify(body))] : []
  return { method, url, headers, on(ev, cb) { if (ev === 'data') chunks.forEach((c) => cb(c)); if (ev === 'end') cb() } }
}
function mockRes() {
  const res = { statusCode: 0, headers: {}, body: null }
  res.writeHead = (s, h) => { res.statusCode = s; Object.assign(res.headers, h) }
  res.end = (b) => { res.body = b?.toString() ?? '' }
  return res
}

test('schedule 默认值：停用 · 每 12 小时', () => {
  const s = getSchedule()
  assert.equal(s.enabled, false)
  assert.equal(s.hours, 12)
  assert.equal(s.last_run, null)
})

test('saveSchedule：写入并夹取 hours（1..168）', () => {
  const s = saveSchedule({ enabled: true, hours: 9999 })
  assert.equal(s.enabled, true)
  assert.equal(s.hours, 168, '超上限夹到 168')
  assert.ok(existsSync(join(dataDir, 'invest-radar', 'schedule.json')), 'schedule.json 落盘')
  assert.equal(getSchedule().hours, 168)
})

test('API：GET /api/schedule 返回状态；POST 保存；POST runNow 调宿主钩子', async () => {
  let runNowCalls = 0
  registerApi(
    { get: () => null, webServer: { register: (x) => captured.push(x) } },
    { config: {}, runFetchNow: async () => { runNowCalls++; saveSchedule({ last_run: new Date().toISOString(), last_count: 42 }); return { ok: true, items: 42, failed: 1 } }, isFetching: () => false },
  )
  const handler = captured[captured.length - 1].handler

  let res = mockRes()
  await handler(mockReq('GET', '/invest-radar/api/schedule'), res)
  assert.equal(res.statusCode, 200)
  const state = JSON.parse(res.body)
  assert.equal(typeof state.schedule.enabled, 'boolean')
  assert.equal(state.running, false)

  res = mockRes()
  await handler(mockReq('POST', '/invest-radar/api/schedule', { 'content-type': 'application/json' }, { enabled: true, hours: 6 }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.body).schedule.hours, 6)

  res = mockRes()
  await handler(mockReq('POST', '/invest-radar/api/schedule', { 'content-type': 'application/json' }, { runNow: true }), res)
  assert.equal(res.statusCode, 200)
  const r = JSON.parse(res.body)
  assert.equal(r.ok, true)
  assert.equal(r.items, 42)
  assert.equal(runNowCalls, 1)
  assert.ok(JSON.parse(readFileSync(join(dataDir, 'invest-radar', 'schedule.json'), 'utf8')).last_run, 'runNow 回写 last_run')
})
