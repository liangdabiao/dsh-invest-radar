// 单测：fetcher 移植自原项目 fetch.py + test_fetch.py（MIT，simonlin1212/investment-news）。
// 重点不只是"重复的要去掉"，更是"不重复的绝不能被去掉"——去重做过头是静默丢新闻。
// 运行：npm test（全程离线，不依赖网络）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeUrl, normalizeTitle, dedup, parseDate, parseFeed, beijingTime } from '../lib/fetcher.js'

const DAY = 86400
const BASE_TS = 1_770_000_000
const item = (title, url, ts = BASE_TS, source = '某源') => ({ title, url, ts, source, summary: '' })

// ── normalizeUrl ───────────────────────────────────────────────────────
test('url: 跟踪参数被剥掉', () => {
  assert.equal(normalizeUrl('https://x.com/a?utm_source=rss&utm_medium=feed'), normalizeUrl('https://x.com/a'))
})
test('url: 有意义的 query 保留（?p=123 与 ?p=456 是两篇文章）', () => {
  assert.notEqual(normalizeUrl('https://x.com/?p=123'), normalizeUrl('https://x.com/?p=456'))
})
test('url: 转义过的分隔符保持区分（%26 解码后重组必须重新转义）', () => {
  assert.notEqual(normalizeUrl('https://x.com/a?id=a%26b%3Dc'), normalizeUrl('https://x.com/a?id=a&b=c'))
})
test('url: 锚点与尾斜杠忽略', () => {
  assert.equal(normalizeUrl('https://x.com/a/#section'), normalizeUrl('https://x.com/a'))
})
test('url: scheme/host 大小写不敏感（path 保留）', () => {
  assert.equal(normalizeUrl('HTTPS://X.COM/Path'), normalizeUrl('https://x.com/Path'))
})
test('url: 空与畸形不抛异常', () => {
  assert.equal(normalizeUrl(''), '')
  assert.equal(normalizeUrl(null), '')
  assert.equal(typeof normalizeUrl('https://[broken'), 'string')
})
test('url: source/from/ref 这类通用词不剥（可能是文章标识）', () => {
  assert.notEqual(normalizeUrl('https://x.com/a?source=alpha'), normalizeUrl('https://x.com/a?source=beta'))
  assert.notEqual(normalizeUrl('https://x.com/a?from=1'), normalizeUrl('https://x.com/a?from=2'))
})
test('url: 无歧义跟踪参数仍要剥', () => {
  const base = normalizeUrl('https://x.com/a')
  for (const q of ['utm_source=rss', 'fbclid=abc', 'gclid=xyz', 'spm=1.2.3']) {
    assert.equal(normalizeUrl(`https://x.com/a?${q}`), base, q)
  }
})

// ── normalizeTitle（中文标题：Python \w 是 unicode 语义）────────────────
test('title: 标点与大小写忽略', () => {
  assert.equal(normalizeTitle("Apple's Q3: Revenue Up!"), normalizeTitle('apple s q3 revenue up'))
})
test('title: 中文标题保留文字、不同标题不同 key', () => {
  assert.notEqual(normalizeTitle('英伟达发布新卡'), normalizeTitle('英伟达财报'))
  assert.equal(normalizeTitle('英伟达发布新卡'), '英伟达发布新卡')
})

// ── dedup（全部反向用例一条不能少）─────────────────────────────────────
test('dedup: 同 URL 只留最新', () => {
  const out = dedup([
    item('标题 A', 'https://x.com/a', BASE_TS),
    item('标题 A 旧抓取', 'https://x.com/a?utm_source=rss', BASE_TS - 3600),
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].ts, BASE_TS)
})
test('dedup: 不同源转载同标题且时间相近 → 只留一条', () => {
  const out = dedup([
    item('英伟达发布新一代加速卡', 'https://a.com/1', BASE_TS, 'A 媒体'),
    item('英伟达发布新一代加速卡', 'https://b.com/2', BASE_TS - 7200, 'B 媒体'),
  ])
  assert.equal(out.length, 1)
})
test('dedup: 跨周复用的固定栏目名绝不能清掉', () => {
  const out = dedup([
    item('每周综述', 'https://a.com/w3', BASE_TS),
    item('每周综述', 'https://a.com/w2', BASE_TS - 7 * DAY),
    item('每周综述', 'https://a.com/w1', BASE_TS - 14 * DAY),
  ])
  assert.equal(out.length, 3)
})
test('dedup: 标题基准跟着最近保留的那条走（20h/70h/100h 案例）', () => {
  const out = dedup([
    item('每周综述', 'https://a.com/1', BASE_TS - 20 * 3600),
    item('每周综述', 'https://b.com/2', BASE_TS - 70 * 3600), // 50h 超窗 → 合法复现，留
    item('每周综述', 'https://c.com/3', BASE_TS - 100 * 3600), // 与 70h 差 30h → 转载，删
  ])
  assert.deepEqual(out.map((i) => i.url), ['https://a.com/1', 'https://b.com/2'])
})
test('dedup: 靠 query 区分的两篇都留', () => {
  const out = dedup([
    item('文章一', 'https://x.com/?p=123', BASE_TS),
    item('文章二', 'https://x.com/?p=456', BASE_TS - 60),
  ])
  assert.equal(out.length, 2)
})
test('dedup: 无时间戳不做标题去重（判错删掉 = 永久丢一篇）', () => {
  const out = dedup([item('无日期新闻', 'https://a.com/1', 0), item('无日期新闻', 'https://b.com/2', 0)])
  assert.equal(out.length, 2)
})
test('dedup: 无时间戳仍按 URL 去重', () => {
  const out = dedup([item('无日期新闻', 'https://a.com/1', 0), item('无日期新闻', 'https://a.com/1', 0)])
  assert.equal(out.length, 1)
})
test('dedup: 畸形链接不中断整次刷新', () => {
  const out = dedup([item('正常', 'https://a.com/1'), item('畸形', 'https://[broken')])
  assert.equal(out.length, 2)
})
test('dedup: 链式转载传递折叠（(A,url1)→(A,url2)→(B,url2) 是同一条）', () => {
  const out = dedup([
    item('英伟达发布新卡', 'https://a.com/x', BASE_TS),
    item('英伟达发布新卡', 'https://b.com/y', BASE_TS - 3600),
    item('NVIDIA 推出新一代加速卡', 'https://b.com/y', BASE_TS - 7200),
  ])
  assert.equal(out.length, 1)
})
test('dedup: 登记被丢弃条目不误删后续不同新闻', () => {
  const out = dedup([
    item('英伟达发布新卡', 'https://a.com/x', BASE_TS),
    item('英伟达发布新卡', 'https://b.com/y', BASE_TS - 3600), // 转载，丢
    item('AMD 发布新卡', 'https://c.com/z', BASE_TS - 7200), // 不同新闻，留
  ])
  assert.equal(out.length, 2)
})
test('dedup: 顺序保持 / 无重复不动 / 空输入', () => {
  const ordered = dedup([
    item('第一条', 'https://a.com/1', BASE_TS),
    item('第二条', 'https://a.com/2', BASE_TS - 100),
    item('第三条', 'https://a.com/3', BASE_TS - 200),
  ])
  assert.deepEqual(ordered.map((i) => i.title), ['第一条', '第二条', '第三条'])
  assert.equal(dedup([item('A', 'https://a.com/1', BASE_TS), item('B', 'https://a.com/2', BASE_TS - 10)]).length, 2)
  assert.deepEqual(dedup([]), [])
})

// ── 时间 ───────────────────────────────────────────────────────────────
test('time: RFC2822 与 ISO 解析；naive ISO 补 UTC；非法→null', () => {
  const t1 = parseDate('Mon, 02 Jun 2025 08:00:00 GMT')
  const t2 = parseDate('2025-06-02T08:00:00Z')
  const t3 = parseDate('2025-06-02T08:00:00') // naive → UTC
  const t4 = parseDate('2025-06-02 08:00') // 空格形态 naive → UTC
  assert.equal(t1.getTime(), t2.getTime())
  assert.equal(t3.getTime(), t2.getTime())
  assert.equal(t4.getTime(), t2.getTime())
  assert.equal(parseDate('not a date'), null)
  assert.equal(parseDate(''), null)
})
test('time: 北京时间格式 MM-DD HH:MM（固定 +8）', () => {
  const ts = Date.UTC(2025, 5, 2, 23, 30) // UTC 23:30 → 北京 07:30 (+1d)
  assert.equal(beijingTime(ts), '06-03 07:30')
})

// ── parseFeed（RSS/Atom fixture）───────────────────────────────────────
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<item><title><![CDATA[Nvidia launches new chip]]></title>
  <link>https://nvidia.com/news/1</link>
  <pubDate>Mon, 02 Jun 2025 08:00:00 GMT</pubDate>
  <description>&lt;p&gt;Blackwell 量产提前 &amp;amp; 良率 90%&lt;/p&gt;</description></item>
<item><title>赌场式加密货币收益承诺</title><link>https://spam.example/1</link><pubDate>Mon, 02 Jun 2025 07:00:00 GMT</pubDate></item>
<item><title>旧新闻不该出现</title><link>https://old.example/1</link><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
</channel></rss>`

test('feed: RSS 解析（CDATA/实体/剥HTML/红线/截止/限额）', () => {
  const cutoff = Date.parse('2025-05-01T00:00:00Z')
  const out = parseFeed(RSS, { name: '测试源' }, {
    perSource: 5,
    cutoffMs: cutoff,
    redline: ['加密货币', '赌场'],
  })
  assert.equal(out.length, 1) // 红线 1 条 + 截止前 1 条被滤掉
  assert.equal(out[0].title, 'Nvidia launches new chip')
  assert.equal(out[0].url, 'https://nvidia.com/news/1')
  assert.equal(out[0].time, '06-02 16:00') // UTC 08:00 → 北京 16:00
  assert.equal(out[0].ts, Date.parse('2025-06-02T08:00:00Z') / 1000)
  // 与 Python ElementTree 单次解码语义一致：&amp;amp; 解一次成 &amp;（原文如此，不二次解码）
  assert.equal(out[0].summary, 'Blackwell 量产提前 &amp; 良率 90%')
})
test('feed: Atom 形态（link href 属性 + entry 标签 + 每源限额）', () => {
  const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>第一条</title><link rel="alternate" href="https://x.com/1"/><published>2025-06-02T08:00:00Z</published></entry>
  <entry><title>第二条</title><link href="https://x.com/2"/><updated>2025-06-01T08:00:00Z</updated></entry>
  <entry><title>第三条</title><link href="https://x.com/3"/><updated>2025-05-31T08:00:00Z</updated></entry>
  <entry><title>第四条（超限，不该出现）</title><link href="https://x.com/4"/><updated>2025-05-30T08:00:00Z</updated></entry>
</feed>`
  const out = parseFeed(atom, { name: 'Atom源' }, { perSource: 3, cutoffMs: 0, redline: [] })
  assert.equal(out.length, 3)
  assert.equal(out[0].url, 'https://x.com/1')
  assert.equal(out[0].time, '06-02 16:00')
})
test('feed: 无标题条目跳过；标题为判空标准', () => {
  const xml = '<rss><channel><item><link>https://x.com/1</link></item><item><title>有标题</title><link>https://x.com/2</link></item></channel></rss>'
  const out = parseFeed(xml, { name: 's' }, { perSource: 5, cutoffMs: 0, redline: [] })
  assert.equal(out.length, 1)
  assert.equal(out[0].title, '有标题')
})
