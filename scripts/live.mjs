// 真实网络冒烟：抓全部内置源，打印成功率（国内直连/代理均可验证）。
//   DSH_HOME=<目录> node scripts/live.mjs [proxyUrl]
// 成功后 feed.json 存进 DSH_HOME，面板独立预览直接可用。
import { fetchAll } from '../lib/fetcher.js'
import { DEFAULT_CONFIG, listSources, saveFeed } from '../lib/store.js'

const proxyUrl = process.argv[2] || process.env.HTTPS_PROXY || ''
const t0 = Date.now()
console.log(`真实抓取：${listSources().length} 源 · 代理=${proxyUrl || '直连'} · 超时 20s`)
const feed = await fetchAll(
  { industries: DEFAULT_CONFIG.industries, sources: listSources() },
  { recentDays: 7, perSource: 5, timeout: 20000, proxyUrl, concurrency: 40, redline: DEFAULT_CONFIG.redline_keywords || [] },
)
const saved = saveFeed(feed)
const totalItems = feed.industries.reduce((n, b) => n + b.items.length, 0)
console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(0)}s · 成功 ${listSources().length - saved.failed_sources.length}/${listSources().length} · 新闻 ${totalItems} 条 · 去重 ${saved.dup_removed} 条`)
for (const b of feed.industries) console.log(`  ${b.name.padEnd(14)} ${String(b.total).padStart(3)} 源 → ${String(b.items.length).padStart(4)} 条`)
if (saved.failed_sources.length) console.log(`\n失败源：\n  ` + saved.failed_sources.slice(0, 20).join('\n  '))
