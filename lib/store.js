// 投资雷达 · 数据层。
//   $DSH_HOME/invest-radar/
//   ├── feed.json          最近一次抓取全量（generated_at/industries/stats/failed）
//   ├── digests.json       agent 提炼存档（按赛道合并：要点+refs+翻译）
//   └── sources.user.json  用户源覆盖（{add:[...], remove:[源名]}——不动内置 106 源）
// 原子写与档案库沿用 dsh-resume-matcher 同款（tmp + rename）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import defaultSources from './sources.default.json' with { type: 'json' }

export const DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'invest-radar')
const FEED_FILE = join(DATA_DIR, 'feed.json')
const DIGESTS_FILE = join(DATA_DIR, 'digests.json')
const USER_SOURCES_FILE = join(DATA_DIR, 'sources.user.json')

export const DEFAULT_CONFIG = defaultSources // { fetch, industries, sources, redline_keywords, _comment }

const nowIso = () => new Date().toISOString()

function readJson(file, fallback = null) {
  if (!existsSync(file)) return fallback
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

// ── feed（最近一次抓取）────────────────────────────────────────────────
export function saveFeed(feed) {
  const { _failed, _dup_removed, ...data } = feed
  const record = { ...data, failed_sources: _failed || [], dup_removed: _dup_removed || 0, saved_at: nowIso() }
  writeJson(FEED_FILE, record)
  return record
}
export const getFeed = () => readJson(FEED_FILE)

// ── digests（agent 提炼存档，按赛道合并）───────────────────────────────
export function getDigests() {
  return readJson(DIGESTS_FILE, { sectors: {}, updated_at: null }) || { sectors: {}, updated_at: null }
}

// entry: { key, points:[{t,url}], items:[{url,zh}] }；同名赛道合并覆盖
export function saveDigest(entry) {
  const all = getDigests()
  const prev = all.sectors[entry.key] || {}
  all.sectors[entry.key] = {
    key: entry.key,
    points: Array.isArray(entry.points) ? entry.points.slice(0, 10) : [],
    items: Array.isArray(entry.items) ? entry.items : [],
    updated_at: nowIso(),
    prev_updated_at: prev.updated_at || null,
  }
  all.updated_at = nowIso()
  writeJson(DIGESTS_FILE, all)
  return all.sectors[entry.key]
}

// ── 信息源（内置 106 + 用户覆盖）───────────────────────────────────────
function getUserSources() {
  return readJson(USER_SOURCES_FILE, { add: [], remove: [] }) || { add: [], remove: [] }
}

export function listSources() {
  const user = getUserSources()
  const removed = new Set(user.remove.map((n) => n.toLowerCase()))
  const list = DEFAULT_CONFIG.sources.filter((s) => !removed.has(String(s.name).toLowerCase()))
  const seen = new Set(list.map((s) => String(s.url)))
  for (const s of user.add) {
    if (!seen.has(String(s.url))) list.push(s)
  }
  return list
}

export function addSource({ name, url, sector }) {
  const user = getUserSources()
  if (user.add.some((s) => String(s.url) === String(url))) return { ok: false, error: '该 URL 已存在' }
  user.add.push({ name: String(name || url), hint: String(sector || ''), type: 'rss', url: String(url) })
  // 同时从 remove 里捞回来（先删后加的同名源）
  user.remove = user.remove.filter((n) => String(n).toLowerCase() !== String(name || '').toLowerCase())
  writeJson(USER_SOURCES_FILE, user)
  return { ok: true }
}

export function removeSource(name) {
  const user = getUserSources()
  const key = String(name).toLowerCase()
  if (!DEFAULT_CONFIG.sources.some((s) => String(s.name).toLowerCase() === key) && !user.add.some((s) => String(s.name).toLowerCase() === key)) {
    return { ok: false, error: `没有叫「${name}」的源` }
  }
  if (!user.remove.some((n) => String(n).toLowerCase() === key)) user.remove.push(String(name))
  user.add = user.add.filter((s) => String(s.name).toLowerCase() !== key)
  writeJson(USER_SOURCES_FILE, user)
  return { ok: true }
}

// ── 汇总 ───────────────────────────────────────────────────────────────
export function status() {
  const feed = getFeed()
  const digests = getDigests()
  const out = {
    dataDir: DATA_DIR,
    feed: null,
    sectors: [],
  }
  if (feed) {
    out.feed = {
      generated_at: feed.generated_at,
      recent_days: feed.recent_days,
      total_sources: feed.stats?.total_sources ?? 0,
      failed_count: (feed.failed_sources || []).length,
      dup_removed: feed.dup_removed || 0,
    }
    for (const ind of feed.industries || []) {
      const dg = digests.sectors?.[ind.key]
      out.sectors.push({
        key: ind.key, name: ind.name, items: ind.items?.length || 0,
        points: dg?.points?.length || 0,
        digest_at: dg?.updated_at || null,
      })
    }
  }
  out.digest_updated_at = digests.updated_at
  return out
}
