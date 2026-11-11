// 单测：store 数据层 —— 源开关（enable/disable）与定时抓取配置。
// 全程离线：DSH_HOME 指向临时目录（store.js 在 import 时读取，故先设 env 再动态 import）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'ir-store-'))
const { DEFAULT_CONFIG, listAllSources, listSources, setSourceEnabled, addSource, removeSource, getSchedule, saveSchedule } = await import('../lib/store.js')

const first = DEFAULT_CONFIG.sources[0].name

// ── 源开关 ─────────────────────────────────────────────────────────────
test('sources: 默认清单全部启用', () => {
  const all = listAllSources()
  assert.ok(all.length >= 100)
  assert.ok(all.every((s) => s.enabled === true))
  assert.equal(listSources().length, all.length)
})

test('sources: disable 后生效清单跳过、全量清单保留', () => {
  assert.equal(setSourceEnabled(first, false).ok, true)
  assert.ok(listSources().every((s) => s.name !== first))
  const off = listAllSources().find((s) => s.name === first)
  assert.equal(off.enabled, false)
})

test('sources: enable 恢复抓取', () => {
  assert.equal(setSourceEnabled(first, true).ok, true)
  assert.ok(listSources().some((s) => s.name === first))
  assert.equal(listAllSources().find((s) => s.name === first).enabled, true)
})

test('sources: 未知源开关要报错', () => {
  assert.equal(setSourceEnabled('不存在的源XYZ', false).ok, false)
})

test('sources: 用户加的源同样可开关', () => {
  assert.equal(addSource({ name: '临时源X', url: 'https://example.com/x.xml', sector: 'ai' }).ok, true)
  assert.equal(setSourceEnabled('临时源X', false).ok, true)
  assert.equal(listSources().some((s) => s.name === '临时源X'), false)
  assert.equal(setSourceEnabled('临时源X', true).ok, true)
  assert.equal(listSources().some((s) => s.name === '临时源X'), true)
})

test('sources: 删除源顺带清掉停用记录', () => {
  assert.equal(setSourceEnabled(first, false).ok, true)
  assert.equal(removeSource(first).ok, true)
  assert.ok(!listAllSources().some((s) => s.name === first))
})

// ── 定时抓取配置 ───────────────────────────────────────────────────────
test('schedule: hours 夹取 1-168，enabled 归一化为布尔', () => {
  assert.equal(saveSchedule({ enabled: true, hours: 999 }).hours, 168)
  assert.equal(saveSchedule({ enabled: true, hours: -5 }).hours, 1)
  const s = saveSchedule({ enabled: 0, hours: 0 }) // 0 视为未设置 → 回退默认 12
  assert.equal(s.enabled, false)
  assert.equal(s.hours, 12)
  assert.equal(getSchedule().hours, 12)
})

test('schedule: 默认关闭', () => {
  const s = getSchedule()
  assert.equal(s.enabled, false)
  assert.equal(s.last_run, null)
})
