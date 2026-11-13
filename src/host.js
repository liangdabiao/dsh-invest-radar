// 投资雷达 · Host 半边（invest_news 原生工具 + news-digest 技能提供方 + 硬规则注入 + 面板数据面）。
// 抓取/去重/红线是纯数据操作由工具完成；「今日要点」与翻译由会话模型按 news-digest 技能提炼后 digest_save 存档。
import Schema from '@deepseek-ai/schemastery'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillProvider } from '../lib/skills.js'
import { systemSection } from './systemPrompt.js'
import { registerApi } from '../lib/api.js'
import { fetchAll } from '../lib/fetcher.js'
import {
  DEFAULT_CONFIG, getFeed, listAllSources, listSources, saveFeed, saveDigest,
  addSource, removeSource, setSourceEnabled, status, getSchedule, saveSchedule,
  getSettings, saveSettings,
} from '../lib/store.js'

export const name = 'invest-radar' // = cordis.patch.yml 的 id

export const inject = ['tools', 'skills', 'systemPrompt', 'webServer', 'connection']

export const Config = Schema.object({
  injectRules: Schema.boolean().default(true).description('注入投资雷达工作流到系统提示'),
  proxyUrl: Schema.string().default('').description('HTTP(S) 代理（海外源抓取用），留空读 HTTPS_PROXY 环境变量'),
  timeout: Schema.number().default(30000).description('单源抓取超时（毫秒）'),
  recentDays: Schema.number().default(7).description('只保留最近 N 天的新闻'),
  perSource: Schema.number().default(5).description('每个源最多取多少条'),
  concurrency: Schema.number().default(40).description('并发抓取数'),
})

function check(args, spec) {
  const problems = []
  for (const key of spec.required || []) {
    if (args?.[key] === undefined) problems.push(`缺少必填参数 ${key}`)
  }
  for (const [key, rule] of Object.entries(spec.properties || {})) {
    const value = args?.[key]
    if (value === undefined) continue
    if (rule.enum && !rule.enum.includes(value)) problems.push(`${key} 只能是 ${rule.enum.join(' / ')} 之一`)
  }
  for (const key of Object.keys(args || {})) {
    if (!spec.properties || !(key in spec.properties)) problems.push(`未知参数 ${key}`)
  }
  if (problems.length) throw new Error(`参数有误：${problems.join('；')}。`)
}

const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const text = (value) => [{ type: 'text', text: value }]

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['ok', 'summary'],
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string', description: '给模型看的回执' },
      data: { type: 'string', description: '可选：新闻列表/状态/源清单' },
    },
  },
  render: (_args, value) => text(value.data ? `${value.summary}\n\n${value.data}` : value.summary),
}

const result = (ok, summary, data = '') => ({ ok, summary, data })

const MAX_TEXT = 40000
const SECTOR_KEYS = DEFAULT_CONFIG.industries.map((i) => i.key)
const SECTOR_NAME = Object.fromEntries(DEFAULT_CONFIG.industries.map((i) => [i.key, i.name]))

// "ai,semi" / "AI,半导体" → key 数组；空/非法则返回 null（全部）
function parseSectors(input) {
  if (!input) return null
  const keys = String(input).split(/[,，、\s]+/).filter(Boolean).map((s) => {
    const lower = s.toLowerCase()
    if (SECTOR_KEYS.includes(lower)) return lower
    const byName = DEFAULT_CONFIG.industries.find((i) => i.name.includes(s) || s.includes(i.name.split(' /')[0]))
    return byName?.key
  }).filter(Boolean)
  return keys.length ? keys : null
}

// fetch 参数（工具 fetch 与面板定时抓取共用一份）
const fetchOpts = (cfg = {}) => ({
  recentDays: cfg.recentDays ?? 7,
  perSource: cfg.perSource ?? 5,
  timeout: cfg.timeout ?? 30000,
  proxyUrl: cfg.proxyUrl || getSettings().proxy_url || process.env.HTTPS_PROXY || process.env.HTTPS_proxy || process.env.HTTP_PROXY || '',
  concurrency: cfg.concurrency ?? 40,
  redline: DEFAULT_CONFIG.redline_keywords || [],
})

// ---------------------------------------------------------------------------
// 工具：invest_news —— 抓取 / 列表 / 提炼存档 / 状态 / 源管理
// ---------------------------------------------------------------------------
export const investNewsTool = {
  name: 'invest_news',
  description:
    '投资雷达档案库：抓取 12 大赛道（一一对应 A股板块）× 100+ 海外权威 RSS 源，去重与合规过滤；' +
    '读取新闻列表供提炼；保存「今日要点」+ 中文标题翻译存档（侧栏「投资雷达」看板呈现）。' +
    '流程：status 看新鲜度 → fetch 抓取 → list 读新闻 → 按 news-digest 技能提炼 → digest_save 存档。' +
    '提炼（要点+翻译）由你完成，工具不调外部 LLM。源可临时停用（disable，fetch 跳过）；' +
    '定时自动抓取在面板「信息源」页配置；用户要「定时全自动刷新（抓+提炼）」时用 DSH 定时任务（schedule_create）创建，先确认频率。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: str('fetch 抓取；list 读新闻；digest_save 存提炼；status 看新鲜度；sources 源管理', {
        enum: ['fetch', 'list', 'digest_save', 'status', 'sources'],
      }),
      sectors: str('fetch/list：可选，逗号分隔的赛道 key 或名称（如 "ai,semi" / "AI,半导体"）；省略=全部 12 赛道'),
      limit: str('list：每赛道最多返回条数，默认 16（与提炼规范 TOPN 一致）'),
      digestJson: str('digest_save：JSON 字符串。单赛道 {"key":"ai","points":[{"t":"要点","url":"原文链接"}],"items":[{"url":"新闻链接","zh":"中文标题"}]} 或赛道数组'),
      sourceAction: str('sources：list 列全部 / add 加源 / remove 删源 / enable 启用 / disable 停用（停用的源 fetch 跳过）', { enum: ['list', 'add', 'remove', 'enable', 'disable'] }),
      name: str('sources add/remove/enable/disable：源名'),
      url: str('sources add：RSS 地址'),
      sector: str('sources add：所属赛道 key（status/sources list 里能看到）'),
    },
  },
  output: OUTPUT,
  async execute(args, ctxConfig) {
    check(args, this.parameters)
    const cfg = ctxConfig || {}

    // ── fetch ────────────────────────────────────────────────────────────
    if (args.action === 'fetch') {
      const keys = parseSectors(args.sectors)
      const industries = keys ? DEFAULT_CONFIG.industries.filter((i) => keys.includes(i.key)) : DEFAULT_CONFIG.industries
      const sources = listSources().filter((s) => industries.some((i) => i.key === s.hint)) // listSources 已剔除停用源
      if (!sources.length) return result(false, `赛道 ${args.sectors || '全部'} 下没有可用源（可能都被停用或删除）。sources action=list 先看清单，enable 可重新打开。`)
      const opts = fetchOpts(cfg)
      const feed = await fetchAll({ industries, sources }, opts)
      const saved = saveFeed(feed)
      const lines = feed.industries.map((b) => `${b.name}：${b.items.length} 条`)
      const failedNote = saved.failed_sources.length ? `；${saved.failed_sources.length}/${sources.length} 源失败（${saved.failed_sources.slice(0, 8).join('、')}${saved.failed_sources.length > 8 ? '…' : ''}）${opts.proxyUrl ? '' : '——海外源建议配 proxyUrl'}` : `；${sources.length} 源全部成功`
      return result(true,
        `抓取完成（${feed.generated_at}，最近 ${feed.recent_days} 天，去重 ${saved.dup_removed} 条）${failedNote}。接下来：list 读新闻 → 按 news-digest 技能提炼 → digest_save 存档。`,
        lines.join('\n'))
    }

    // ── list ─────────────────────────────────────────────────────────────
    if (args.action === 'list') {
      const feed = getFeed()
      if (!feed) return result(false, '还没有抓取数据。先 fetch（或让用户点看板刷新）。')
      const keys = parseSectors(args.sectors) || feed.industries.map((i) => i.key)
      const limit = Math.min(Number(args.limit) || 16, 40)
      const out = []
      for (const key of keys) {
        const ind = feed.industries.find((x) => x.key === key)
        if (!ind) continue
        out.push(`【${ind.name}】(${ind.items.length} 条)`)
        ind.items.slice(0, limit).forEach((it, i) => {
          out.push(`${i}. [${it.time}] ${it.title}${it.zh ? ` ｜ ${it.zh}` : ''}\n   来源:${it.source} ｜ ${it.url}${it.summary ? `\n   ${it.summary}` : ''}`)
        })
        out.push('')
      }
      const data = out.join('\n')
      return result(true, `新闻列表（提炼按 news-digest 技能执行；要点里的 url 必须来自下列条目）：`,
        data.length > MAX_TEXT ? data.slice(0, MAX_TEXT) + `\n…（超长截断，fetch 时间 ${feed.generated_at}）` : data)
    }

    // ── digest_save ──────────────────────────────────────────────────────
    if (args.action === 'digest_save') {
      if (!args.digestJson) throw new Error('digest_save 需要 digestJson。')
      let parsed
      try {
        parsed = JSON.parse(args.digestJson)
      } catch {
        throw new Error('digestJson 不是合法 JSON。单赛道 {"key","points","items"} 或数组。')
      }
      const entries = Array.isArray(parsed) ? parsed : [parsed]
      const feed = getFeed()
      const lines = []
      for (const e of entries) {
        const key = e?.key
        if (!SECTOR_KEYS.includes(key)) throw new Error(`digestJson 里的赛道 key "${key}" 不存在（合法：${SECTOR_KEYS.join(',')}）。`)
        const saved = saveDigest({
          key,
          points: (e.points || []).map((p) => ({ t: String(p?.t || '').slice(0, 120), url: String(p?.url || '') })),
          items: (e.items || []).map((x) => ({ url: String(x?.url || ''), zh: String(x?.zh || '').slice(0, 120) })),
        })
        lines.push(`${SECTOR_NAME[key]}：要点 ${saved.points.length} · 翻译 ${saved.items.filter((x) => x.zh).length} 条`)
      }
      return result(true,
        `已存档（侧栏「投资雷达」看板立即可见）：${lines.join('；')}。向用户输出要点全文（保留溯源链接）并附免责声明。`)
    }

    // ── status ───────────────────────────────────────────────────────────
    if (args.action === 'status') {
      const st = status()
      if (!st.feed) {
        return result(false, '档案库是空的——还没有抓取过。先 fetch（海外源多，若用户环境有代理请确认已配置）。')
      }
      const f = st.feed
      const lines = st.sectors.map((s) => {
        const fresh = s.items ? `新闻 ${s.items}` : '—'
        return `${s.name}：${fresh}${s.points ? ` · 要点 ${s.points}（${String(s.digest_at).slice(0, 16)}）` : ' · 未提炼'}`
      })
      return result(true,
        `数据时间 ${f.generated_at}（最近 ${f.recent_days} 天）· 源 ${f.total_sources} · 失败 ${f.failed_count} · ${f.failed_count ? '旧数据可直接用，提炼前不必强求重抓' : ''}`,
        lines.join('\n'))
    }

    // ── sources ──────────────────────────────────────────────────────────
    if (args.action === 'sources') {
      const sub = args.sourceAction || 'list'
      if (sub === 'add') {
        if (!args.url) throw new Error('sources add 需要 url（RSS 地址）。')
        if (!args.sector || !SECTOR_KEYS.includes(args.sector)) throw new Error(`sources add 需要 sector（合法：${SECTOR_KEYS.join(',')}）。`)
        const r = addSource({ name: args.name || args.url, url: args.url, sector: args.sector })
        if (!r.ok) return result(false, r.error)
        return result(true, `已加源「${args.name || args.url}」→ ${SECTOR_NAME[args.sector]}。下次 fetch 生效。`)
      }
      if (sub === 'remove') {
        if (!args.name) throw new Error('sources remove 需要 name（源名，list 里能看到）。')
        const r = removeSource(args.name)
        if (!r.ok) return result(false, r.error)
        return result(true, `已删源「${args.name}」。下次 fetch 生效。`)
      }
      if (sub === 'enable' || sub === 'disable') {
        if (!args.name) throw new Error(`sources ${sub} 需要 name（源名，list 里能看到）。`)
        const r = setSourceEnabled(args.name, sub === 'enable')
        if (!r.ok) return result(false, r.error)
        return result(true, sub === 'enable'
          ? `已启用源「${args.name}」，下次 fetch 恢复抓取。`
          : `已停用源「${args.name}」，下次 fetch 起跳过（清单保留，enable 可再打开）。`)
      }
      const feed = getFeed()
      const failed = feed?.failed_sources || []
      const sources = listAllSources()
      const enabledCount = sources.filter((s) => s.enabled !== false).length
      const lines = DEFAULT_CONFIG.industries.map((ind) => {
        const list = sources.filter((s) => s.hint === ind.key)
        const marks = list.map((s) => `${s.enabled === false ? '⏸' : failed.some((f) => f.startsWith(`${s.name}:`)) ? '🔴' : '🟢'}${s.name}`).join('、')
        return `${ind.name}（启用 ${list.filter((s) => s.enabled !== false).length}/${list.length}）：${marks || '—'}`
      })
      return result(true,
        `共 ${sources.length} 个源，启用 ${enabledCount} 个（🟢 正常 🔴 上次抓取失败 ⏸ 已停用；enable/disable 可临时开关，remove 才是删）：`,
        lines.join('\n').slice(0, MAX_TEXT))
    }

    throw new Error(`未知 action：${args.action}`)
  },
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------
export function apply(ctx, config) {
  const skillDirs = [join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')]

  const toolWithConfig = { ...investNewsTool, execute(args) { return investNewsTool.execute(args, config) } }

  ctx.effect(() => ctx.tools.register(toolWithConfig), `${name}: tool news`)
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(skillDirs)), `${name}: skills`)
  if (config.injectRules !== false) {
    ctx.effect(() => ctx.systemPrompt.section(systemSection()), `${name}: workflow`)
  }

  // ── 定时抓取：宿主进程内直跑 fetchAll（纯数据层，不需要会话；AI 提炼仍走对话）────
  // 面板「定时抓取」写 schedule.json；这里 30s 心跳读它，到期即全量抓取并回写状态。
  let fetching = false
  const runFetchNow = async () => {
    if (fetching) return { ok: false, error: '上一轮抓取还在进行中' }
    fetching = true
    try {
      const sources = listSources()
      const feed = await fetchAll({ industries: DEFAULT_CONFIG.industries, sources }, {
        recentDays: config.recentDays ?? 7,
        perSource: config.perSource ?? 5,
        timeout: config.timeout ?? 30000,
        proxyUrl: config.proxyUrl || getSettings().proxy_url || process.env.HTTPS_PROXY || process.env.HTTP_proxy || process.env.HTTP_PROXY || '',
        concurrency: config.concurrency ?? 40,
        redline: DEFAULT_CONFIG.redline_keywords || [],
      })
      const saved = saveFeed(feed)
      const items = saved.industries.reduce((n, i) => n + i.items.length, 0)
      saveSchedule({ last_run: new Date().toISOString(), last_error: null, last_count: items })
      return { ok: true, items, failed: saved.failed_sources.length }
    } catch (err) {
      saveSchedule({ last_run: new Date().toISOString(), last_error: String(err?.message || err) })
      return { ok: false, error: String(err?.message || err) }
    } finally { fetching = false }
  }

  ctx.effect(() => registerApi(ctx, { runFetchNow, isFetching: () => fetching }), `${name}: routes`)

  ctx.effect(() => {
    const tick = async () => {
      if (fetching) return
      const sch = getSchedule()
      if (!sch.enabled) return
      const last = sch.last_run ? Date.parse(sch.last_run) : 0
      if (Date.now() - last < (sch.hours || 12) * 3600_000) return
      await runFetchNow()
    }
    const timer = setInterval(() => { tick().catch(() => {}) }, 30_000)
    return () => clearInterval(timer)
  }, `${name}: schedule timer`)
}




