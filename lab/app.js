// 投资雷达 · 面板逻辑：概览 / 赛道看板（要点卡 + 双语新闻列表）/ 信息源管理。
// 「刷新看板」走 agent 对话：嵌入 dsh → postMessage（client.js startSession，有 start-ok 握手）；
// 独立浏览器预览 → 复制草稿。抓取与提炼都是 agent 的活，面板 API 只读存档 + 源配置。
(() => {
  const $app = document.getElementById('app')
  const $toast = document.getElementById('toast')
  const EMBEDDED = (() => { try { return window.parent !== window } catch { return false } })()

  const state = { catalog: null }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const fmt = (s) => String(s ?? '')

  async function api(path) {
    const res = await fetch(`/invest-radar${path}`)
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body
  }
  async function apiPost(path, payload) {
    const res = await fetch(`/invest-radar${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
    return body
  }

  let toastTimer = null
  function toast(msg, isErr) {
    $toast.textContent = msg
    $toast.className = `toast show${isErr ? ' err' : ''}`
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { $toast.className = 'toast' }, 2600)
  }
  async function copyText(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg || '已复制到剪贴板') }
    catch { toast('复制失败，请手动选择文本', true) }
  }
  function copyFallback(prompt, reason) {
    navigator.clipboard?.writeText(prompt).then(
      () => toast(`${reason}，草稿已复制到剪贴板——请粘贴到 dsh 对话`, true),
      () => toast(`${reason}，复制也失败了`, true))
  }

  const ICONS = {
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/>',
    board: '<rect x="4" y="5" width="16" height="14"/><path d="M4 10h16"/><path d="M10 10v9"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    go: '<path d="M9 6l6 6-6 6"/>',
    trash: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/>',
    pause: '<path d="M9 5v14"/><path d="M15 5v14"/>',
    play: '<path d="M8 5l11 7-11 7V5z"/>',
    spark: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/>',
    ext: '<path d="M14 5h5v5"/><path d="M19 5l-8 8"/><path d="M18 14v5H5V6h5"/>',
    back: '<path d="M14 6l-6 6 6 6"/>',
  }
  const ic = (name, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`

  async function loadCatalog() {
    state.catalog = await api('/api/catalog')
    renderNavCounts()
    renderRailFoot()
    return state.catalog
  }
  function renderNavCounts() {
    const c = state.catalog
    if (!c) return
    document.querySelectorAll('[data-count]').forEach((n) => {
      if (n.dataset.count === 'sources') n.textContent = c.stats.active_sources
    })
  }
  function renderRailFoot() {
    const c = state.catalog
    if (!c) return
    document.getElementById('rail-foot').innerHTML =
      `<div class="v-head">INVEST RADAR v${esc(c.version)}</div>` +
      `<div class="v-row"><span>数据时间</span><span>${esc(c.generated_at || '—')}</span></div>` +
      `<div class="v-row"><span>新闻 / 要点</span><span>${c.stats.items} / ${c.stats.points}</span></div>` +
      `<div class="v-row"><span>源（活跃）</span><span>${c.stats.total_sources}（${c.stats.active_sources}）</span></div>`
  }

  // ---------- 发起刷新（agent 对话） ----------
  function refreshPrompt(sectors) {
    const s = sectors ? `先只处理这些赛道：${sectors}。` : ''
    return [
      '请刷新投资雷达：',
      `1. invest_news(action="status") 看数据新鲜度${s}`,
      '2. invest_news(action="fetch") 抓取（失败源如实记录，不重试轰炸）',
      '3. 对每个赛道：invest_news(action="list") 读最新新闻 → 按 news-digest 技能提炼 3-5 条「今日要点」（≤40 字、带原文溯源链接）+ 每条新闻中文标题翻译 → invest_news(action="digest_save") 存档',
      '4. 最后给我 2-3 条今天最值得关注的信号，附免责声明。',
    ].join('\n')
  }

  function bindRefresh() {
    document.querySelectorAll('[data-refresh]').forEach((b) => {
      b.onclick = () => sendAgentPrompt(refreshPrompt(b.dataset.refresh || ''), '已在宿主开新对话——agent 会抓取并提炼，完成后回看板')
    })
  }

  // 把一段 prompt 送到 agent 对话（嵌入=开新对话；独立预览=复制草稿）
  function sendAgentPrompt(prompt, okMsg = '已在宿主开新对话——agent 处理中') {
    if (!EMBEDDED) {
      navigator.clipboard?.writeText(prompt).then(
        () => toast('草稿已复制——粘贴到 dsh 对话即可开始'),
        () => copyFallback(prompt, '复制失败'))
      return
    }
    let done = false
    const cleanup = () => { done = true; clearTimeout(timer); removeEventListener('message', onMsg) }
    const onMsg = (e) => {
      if (e.origin !== location.origin) return
      if (e.data?.type === 'invest-radar:start-ok') { if (!done) { cleanup(); toast(okMsg) } }
      else if (e.data?.type === 'invest-radar:start-failed') { if (!done) { cleanup(); toast(`没能开新对话：${e.data.message || ''}`, true) } }
    }
    const timer = setTimeout(() => { if (!done) { cleanup(); copyFallback(prompt, '未收到宿主确认') } }, 1500)
    addEventListener('message', onMsg)
    parent.postMessage({ type: 'invest-radar:refresh', prompt }, location.origin)
  }

  // ---------- 视图：概览 ----------
  function viewHome() {
    const c = state.catalog
    const sectorCards = (c.sectors || []).map((s) => `
      <a class="sector-card" href="#/board/${esc(s.key)}" style="--sc:${esc(sectorAccent(c, s.key))}">
        <div class="s-name"><span class="s-dot"></span>${esc(s.name)}</div>
        <div class="s-nums">新闻 ${s.items} · 要点 ${s.points}${s.digest_at ? ` · ${esc(String(s.digest_at).slice(11, 16))}` : ''}</div>
        ${c.generated_at ? `<div class="s-points" data-points="${esc(s.key)}"></div>` : ''}
      </a>`).join('')
    const failed = c.failed_sources || []
    return `
      <header class="head">
        <span class="eyebrow">INVEST RADAR</span>
        <div class="head-row">
          <h1>投资<strong>雷达</strong></h1>
          <div class="actions"><button class="btn accent" data-refresh="">${ic('spark')}刷新看板</button></div>
        </div>
        <p>12 大赛道一一对应 A股板块，${c.stats.total_sources} 个海外权威源本地抓取，会话模型提炼中文「今日要点」。数据在本机，不构成投资建议。</p>
      </header>
      <div class="stats">
        <div class="stat"><div class="mono">UPDATED</div><div class="val" style="font-size:18px;font-weight:400;padding-top:6px">${esc(c.generated_at || '从未抓取')}</div><div class="sub">最近 ${c.recent_days} 天</div></div>
        <div class="stat"><div class="mono">SOURCES</div><div class="val">${c.stats.active_sources}</div><div class="sub">活跃信息源${c.stats.disabled_sources ? ` · 停用 ${c.stats.disabled_sources}` : ''}${failed.length ? ` · 失败 ${failed.length}` : ''}</div></div>
        <div class="stat"><div class="mono">NEWS</div><div class="val">${c.stats.items}</div><div class="sub">在库新闻</div></div>
        <div class="stat"><div class="mono">POINTS</div><div class="val">${c.stats.points}</div><div class="sub">今日要点</div></div>
      </div>
      ${failed.length ? `<div class="empty" style="margin-bottom:var(--sp-6);padding:var(--sp-4) var(--sp-5);text-align:left"><div class="e-title">⚠️ 上次抓取 ${failed.length} 个源失败</div><p>${esc(failed.slice(0, 6).join(' · '))}${failed.length > 6 ? ' …' : ''}</p><p>海外源在国内网络下需要代理（Config 的 proxyUrl）。</p></div>` : ''}
      <section class="sec">
        <div class="sec-head"><span class="num">01</span><h2>12 赛道</h2><a class="more" href="#/sources">信息源管理 →</a></div>
        ${c.generated_at ? `<div class="sectors">${sectorCards}</div>` : `<div class="empty"><div class="e-title">还没有数据</div><p>点右上「刷新看板」：会开新对话让 agent 抓取全部源并提炼今日要点；独立预览模式则复制草稿到剪贴板。</p><p><button class="btn" data-refresh="" style="margin-top:12px">${ic('spark')}开始第一次抓取</button></p></div>`}
      </section>
      <section class="sec">
        <div class="sec-head"><span class="num">02</span><h2>定时抓取</h2></div>
        <div class="form" style="display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap">
          <div class="field" style="min-width:210px"><label>AUTO FETCH · 自动抓取新闻（本机直连，不含 AI 提炼）</label>
            <select id="sch-hours" style="height:36px;padding:0 8px;background:var(--grey-1);border:1px solid var(--line)">
              <option value="6">每 6 小时</option>
              <option value="12">每 12 小时</option>
              <option value="24">每 24 小时</option>
              <option value="48">每 48 小时</option>
            </select></div>
          <div style="display:flex;gap:8px;padding-bottom:2px">
            <button class="btn accent" id="sch-on">启用</button>
            <button class="btn ghost" id="sch-off">停用</button>
            <button class="btn" id="sch-now">立即抓一次</button>
            <button class="btn ghost" id="sch-agent">${ic('spark')}建全自动定时（抓+提炼）</button>
          </div>
          <div class="hint" id="sch-status" style="flex-basis:100%">…</div>
          <div class="hint" style="flex-basis:100%">这里只自动更新新闻列表（不含 AI 提炼）；想要抓取+提炼全自动，点「建全自动定时」让 agent 用 dsh 定时任务创建，频率可在对话里调整。</div>
        </div>
      </section>
      <section class="sec">
        <div class="sec-head"><span class="num">03</span><h2>怎么用</h2></div>
        <div class="cards">
          <div class="card step"><div class="num">1</div><div class="c-title">刷新</div><p>点「刷新看板」开新对话，agent 抓取 106 个源（去重 + 合规红线过滤），失败源如实报告。</p></div>
          <div class="card step"><div class="num">2</div><div class="c-title">提炼</div><p>agent 按 news-digest 技能逐赛道提炼 3-5 条中文要点（带原文溯源）+ 标题翻译，存档后看板立即可见。</p></div>
          <div class="card step"><div class="num">3</div><div class="c-title">下钻</div><p>看板每栏置顶今日要点，点 ↗ 跳原文核实；「信息源」页管理 106+ 源的健康状态。</p></div>
        </div>
      </section>`
  }

  async function renderHomePoints() {
    // 概览赛道卡里塞入各赛道第一条要点（有数据时）
    const c = state.catalog
    if (!c?.generated_at) return
    for (const s of c.sectors || []) {
      const el = document.querySelector(`[data-points="${s.key}"]`)
      if (!el) continue
      try {
        const { digest, industry } = await api(`/api/feed?sector=${encodeURIComponent(s.key)}`)
        const p = digest?.points?.[0]
        el.textContent = p?.t ? `✦ ${p.t}` : (industry.items?.[0]?.title || '')
      } catch { el.textContent = '' }
    }
  }

  // ---------- 视图：赛道看板 ----------
  async function viewBoard(key) {
    let data
    try {
      data = await api(`/api/feed?sector=${encodeURIComponent(key)}`)
    } catch (e) {
      await loadCatalog()
      return head('赛道看板', '看板 / BOARD') + `<div class="empty"><div class="e-title">没有这条赛道的数据</div><p>${esc(e.message)}</p></div>`
    }
    const ind = data.industry
    const dg = data.digest
    const accent = ind.accent || sectorAccent(state.catalog, ind.key)
    const options = (state.catalog?.sectors || []).map((s) => `<option value="${esc(s.key)}" ${s.key === key ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
    const points = (dg?.points || []).map((p, i) => `
      <div class="digest-item"><span class="d-no">${String(i + 1).padStart(2, '0')}</span>
        <span>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noreferrer">${esc(p.t)}</a>` : esc(p.t)}</span></div>`).join('')
    const zhByurl = new Map((dg?.items || []).map((x) => [x.url, x.zh]))
    const rows = (ind.items || []).map((it) => {
      const zh = zhByurl.get(it.url) || it.zh || ''
      return `<div class="row news-row">
        <div class="r-main">
          <div class="r-title-zh">${esc(zh || it.title)}</div>
          ${zh && zh !== it.title ? `<div class="r-title-en">${esc(it.title)}</div>` : ''}
          ${it.summary ? `<div class="r-sum">${esc(it.summary)}</div>` : ''}
        </div>
        <span class="r-time">${esc(it.time)} · ${esc(it.source)}</span>
        ${it.url ? `<a class="ext" href="${esc(it.url)}" target="_blank" rel="noreferrer" title="跳原文">${ic('ext')}</a>` : ''}
      </div>`
    }).join('')
    return `
      <div class="board-head">
        <a class="back" href="#/">${ic('back')} 概览</a>
        <div class="board-switch">赛道切换 <select id="board-sector">${options}</select></div>
        <button class="btn ghost" data-refresh="${esc(key)}">${ic('spark')}刷新本赛道</button>
      </div>
      <header class="head" style="--sc:${esc(accent)}">
        <span class="eyebrow" style="border-color:${esc(accent)}">SECTOR</span>
        <h1 style="color:var(--ink)">${esc(ind.name)}</h1>
        <p>共 ${ind.total} 个信息源 · 本栏 ${ind.items.length} 条（最近数据 ${esc(state.catalog?.generated_at || '')}）${dg?.updated_at ? ` · 要点生成于 ${esc(String(dg.updated_at).slice(11, 16))}` : ' · 尚未提炼要点'}</p>
      </header>
      ${points ? `<div class="digest" style="--sc:${esc(accent)}">
        <div class="block-head"><h3>✦ AI 今日要点</h3></div>
        <div class="block-body"><div class="digest-list">${points}</div></div></div>`
      : `<div class="empty" style="margin-bottom:var(--sp-6)"><div class="e-title">本赛道还没有要点</div><p>点右上「刷新本赛道」让 agent 抓取并提炼；或去对话里说「提炼 ${esc(ind.name)} 的今日要点」。</p></div>`}
      <div class="rows news" style="--sc:${esc(accent)}">${rows || '<div class="empty" style="border:0">该行业暂未抓到条目。</div>'}</div>
      <p style="margin-top:var(--sp-6);font-size:12px;color:var(--text-helper)">以上为行业资讯聚合与翻译，不构成投资建议。</p>`
  }

  function sectorAccent(catalog, key) {
    return catalog?.sectors?.find((s) => s.key === key)?.accent || '#C2410C'
  }

  function bindBoard() {
    const sel = document.getElementById('board-sector')
    if (sel) sel.onchange = () => { location.hash = `#/board/${sel.value}` }
  }

  // ---------- 视图：信息源 ----------
  function viewSources() {
    return `
      <a class="back" href="#/">${ic('back')} 概览</a>
      <header class="head">
        <span class="eyebrow">SOURCES</span>
        <h1>信息<strong>源</strong></h1>
        <p>内置 106 个权威源（原项目 sources.json），可增删、可临时开关（⏸ 停用的源 fetch 跳过，不删除）。🟢 上次抓取正常 · 🔴 失败 · ⏸ 已停用。改动下次 fetch 生效。</p>
      </header>
      <div class="form" style="margin-bottom:var(--sp-6)">
        <div class="field"><label>PROXY · 海外源代理（抓取与定时抓取都走它；清空保存 = 直连/环境变量）</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="proxy-url" placeholder="http://127.0.0.1:7890" style="flex:1;min-width:220px;height:36px;padding:0 12px;background:var(--grey-1);border:1px solid var(--line);outline:none;font-family:var(--font-mono);font-size:12px">
            <button class="btn" id="proxy-save">保存代理</button>
          </div>
          <div class="hint">默认预填本机常见代理端口 7890；改动立即生效（下次抓取/定时抓取都用它）。海外源直连超时的话，配代理能大幅提升成功率。</div>
        </div>
      </div>
      <div class="form" style="margin-bottom:var(--sp-6)">
        <div class="field"><label>ADD SOURCE · 加源（RSS 地址）</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input id="src-name" placeholder="源名，如 TechCrunch" style="flex:1;min-width:140px;height:36px;padding:0 12px;background:var(--grey-1);border:1px solid var(--line);outline:none">
            <input id="src-url" placeholder="https://…/rss.xml" style="flex:2;min-width:220px;height:36px;padding:0 12px;background:var(--grey-1);border:1px solid var(--line);outline:none">
            <select id="src-sector" style="height:36px;padding:0 8px;background:var(--grey-1);border:1px solid var(--line)"></select>
            <button class="btn" id="src-add">添加</button>
          </div>
          <div class="hint">只支持 RSS/Atom。源名与已有源重名会顶替内置清单里的同名项。</div>
        </div>
      </div>
      <div id="src-table"><div class="loading">LOADING…</div></div>`
  }

  async function renderSourceTable() {
    const el = document.getElementById('src-table')
    if (!el) return
    // 代理设置：预填当前值（默认 http://127.0.0.1:7890）
    try {
      const { settings } = await api('/api/settings')
      const inp = document.getElementById('proxy-url')
      if (inp && document.activeElement !== inp) inp.value = settings.proxy_url || ''
    } catch { /* 宿主未就绪 */ }
    const proxySave = document.getElementById('proxy-save')
    if (proxySave && !proxySave.onclick) proxySave.onclick = async () => {
      const inp = document.getElementById('proxy-url')
      try {
        const r = await apiPost('/api/settings', { proxy_url: inp.value.trim() })
        toast(`代理已保存：${r.settings.proxy_url || '（直连）'}`)
        loadCatalog()
      } catch (e) { toast(e.message, true) }
    }
    let data
    try { data = await api('/api/sources') } catch (e) { el.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return }
    const sel = document.getElementById('src-sector')
    if (sel) sel.innerHTML = data.industries.map((i) => `<option value="${esc(i.key)}">${esc(i.name)}</option>`).join('')
    const failedSet = new Set(data.failed)
    const rows = []
    for (const ind of data.industries) {
      const list = data.bySector[ind.key] || []
      const on = list.filter((s) => s.enabled !== false).length
      rows.push(`<tr class="src-group-head"><td colspan="3">${esc(ind.name)}（启用 ${on}/${list.length}）</td></tr>`)
      for (const s of list) {
        const off = s.enabled === false
        const bad = !off && (s.failed || failedSet.has(`${s.name}:`))
        let host = ''
        try { host = new URL(s.url).host } catch {}
        rows.push(`<tr class="${off ? 'src-off' : ''}">
          <td class="st ${off ? 'off' : bad ? 'bad' : 'ok'}">${off ? '⏸ OFF' : bad ? '🔴 FAIL' : '🟢 OK'}</td>
          <td><div>${esc(s.name)}</div><div class="host">${esc(host)}</div></td>
          <td style="text-align:right;white-space:nowrap">
            <button class="src-del" data-toggle-src="${esc(s.name)}" data-on="${off ? '1' : ''}" title="${off ? '重新启用（fetch 恢复抓取）' : '临时停用（fetch 跳过，不删除）'}">${ic(off ? 'play' : 'pause')}</button>
            <button class="src-del" data-del-src="${esc(s.name)}" title="删除源">${ic('trash')}</button>
          </td>
        </tr>`)
      }
    }
    el.innerHTML = `<table class="src-table">${rows.join('')}</table>`
    el.querySelectorAll('[data-toggle-src]').forEach((b) => {
      b.onclick = async () => {
        const enable = b.dataset.on === '1'
        try {
          await apiPost('/api/sources/toggle', { name: b.dataset.toggleSrc, enabled: enable })
          toast(enable ? '已启用，下次 fetch 恢复抓取' : '已停用，fetch 将跳过该源')
          renderSourceTable()
          loadCatalog()
        } catch (e) { toast(e.message, true) }
      }
    })
    el.querySelectorAll('[data-del-src]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm(`删除信息源「${b.dataset.delSrc}」？（不动内置清单的原始定义，只从生效清单移除）`)) return
        try {
          await apiPost('/api/sources/remove', { name: b.dataset.delSrc })
          toast('已删除')
          renderSourceTable()
          loadCatalog()
        } catch (e) { toast(e.message, true) }
      }
    })
    const addBtn = document.getElementById('src-add')
    if (addBtn) addBtn.onclick = async () => {
      const name = document.getElementById('src-name').value.trim()
      const url = document.getElementById('src-url').value.trim()
      const sector = document.getElementById('src-sector').value
      if (!url || !sector) { toast('RSS 地址与赛道都要填', true); return }
      try {
        await apiPost('/api/sources/add', { name: name || url, url, sector })
        toast('已添加，下次 fetch 生效')
        document.getElementById('src-name').value = ''
        document.getElementById('src-url').value = ''
        loadCatalog()
        renderSourceTable()
      } catch (e) { toast(e.message, true) }
    }
  }

  // ---------- 定时抓取 ----------
  function schStatusText(s) {
    const base = s.enabled ? `启用中 · 每 ${s.hours} 小时` : '已停用'
    const last = s.last_run ? ` · 上次 ${esc(String(s.last_run).slice(5, 16)).replace('T', ' ')}` : ' · 从未运行'
    const err = s.last_error ? ` · ⚠️ ${esc(s.last_error)}` : ''
    const n = s.last_count ? ` · 入库 ${s.last_count} 条` : ''
    return base + last + n + err
  }

  // 让 agent 用 DSH 定时任务建「抓取 + 全赛道提炼」的全自动刷新
  function fullAutoPrompt(hours) {
    return [
      `请为投资雷达创建一个 DSH 定时任务：每 ${hours || 12} 小时自动刷新一次（抓取 + 全赛道提炼 + 存档）。`,
      '要求：',
      '- 用 schedule_create 创建，target 用 new_once（独立新会话，不打断当前对话），标题「定时刷新投资雷达」；',
      '- 每次触发的 prompt 按这个流程走：invest_news(action="status") → invest_news(action="fetch")（失败源如实记录，不重试轰炸）→ 逐赛道 list → 按 news-digest 技能提炼 3-5 条要点（≤40 字、带原文溯源）+ 标题翻译 → digest_save 存档；',
      '- 要点不荐股、不给买卖建议，最后附「以上为行业资讯聚合与翻译，不构成投资建议」；',
      '- 创建完成后，把任务 id、下次触发时间告诉我，并提醒我可在对话里随时改频率或暂停。',
      '创建前先跟我确认这个频率是否合适。',
    ].join('\n')
  }
  async function refreshSchStatus() {
    try {
      const { schedule } = await api('/api/schedule')
      const el = document.getElementById('sch-status')
      if (el) el.textContent = schStatusText(schedule)
      const hours = document.getElementById('sch-hours')
      if (hours) hours.value = String(schedule.hours)
    } catch { /* 宿主未就绪 */ }
  }
  async function bindSchedule() {
    await refreshSchStatus()
    const post = async (payload, okMsg) => {
      try {
        const r = await apiPost('/api/schedule', payload)
        const el = document.getElementById('sch-status')
        if (el && r.schedule) el.textContent = schStatusText(r.schedule)
        toast(okMsg)
        loadCatalog()
      } catch (e) { toast(e.message, true) }
    }
    const on = document.getElementById('sch-on')
    const off = document.getElementById('sch-off')
    const now = document.getElementById('sch-now')
    const hoursEl = document.getElementById('sch-hours')
    const agent = document.getElementById('sch-agent')
    if (on) on.onclick = () => post({ enabled: true, hours: Number(hoursEl?.value) || 12 }, '定时抓取已启用')
    if (off) off.onclick = () => post({ enabled: false }, '定时抓取已停用')
    if (agent) agent.onclick = () => sendAgentPrompt(fullAutoPrompt(Number(hoursEl?.value) || 12), '已在宿主开新对话——agent 会确认频率后创建定时任务')
    if (now) now.onclick = async () => {
      if (now.disabled) return
      now.disabled = true; now.textContent = '抓取中…'
      try {
        const r = await apiPost('/api/schedule', { runNow: true })
        toast(r.ok ? `抓取完成：入库 ${r.items ?? '?'} 条${r.failed ? ` · 失败源 ${r.failed}` : ''}` : `抓取失败：${r.error}`, !r.ok)
        loadCatalog()
      } catch (e) { toast(e.message, true) }
      now.disabled = false; now.textContent = '立即抓一次'
      refreshSchStatus()
    }
  }

  // ---------- 渲染辅助 ----------
  function head(title, eyebrow, actionsHtml = '') {
    return `<header class="head"><span class="eyebrow">${esc(eyebrow)}</span>
      <div class="head-row"><h1>${esc(title)}</h1><div class="actions">${actionsHtml}</div></div></header>`
  }
  function page(loader) {
    $app.innerHTML = '<div class="loading">LOADING…</div>'
    loader().then((result) => {
      const [html, after] = Array.isArray(result) ? result : [result, null]
      $app.innerHTML = html
      bindCommon()
      if (after) after()
    }).catch((e) => { $app.innerHTML = `<div class="empty"><div class="e-title">加载失败</div><p>${esc(e.message)}</p></div>` })
  }

  function bindCommon() {
    bindRefresh()
    bindBoard()
    bindSchedule()
    renderSourceTable()
    renderHomePoints()
  }

  // ---------- 路由 ----------
  async function render() {
    try { await loadCatalog() } catch {}
    const hash = location.hash || '#/'
    const mb = hash.match(/^#\/board\/([\w-]+)$/)
    document.querySelectorAll('.nav a').forEach((a) => {
      const cur = hash === '#/' ? 'home' : hash.startsWith('#/board') || mb ? 'board' : hash.startsWith('#/sources') ? 'sources' : 'home'
      a.classList.toggle('on', a.dataset.view === cur)
    })
    if (mb) { $app.innerHTML = await viewBoard(mb[1]); bindCommon(); return }
    if (hash.startsWith('#/board')) { viewBoardDefault(); return }
    if (hash.startsWith('#/sources')) $app.innerHTML = viewSources()
    else $app.innerHTML = viewHome()
    bindCommon()
  }

  function viewBoardDefault() {
    const c = state.catalog
    if (c?.sectors?.length) { location.hash = `#/board/${c.sectors[0].key}`; return }
    $app.innerHTML = head('赛道看板', '看板 / BOARD') + '<div class="empty"><div class="e-title">还没有数据</div><p>先刷新看板（开对话抓取）。</p></div>'
    bindCommon()
  }

  async function boot() {
    try {
      await loadCatalog()
    } catch {
      state.catalog = { version: '-', generated_at: null, recent_days: 7, failed_sources: [], stats: { total_sources: 106, active_sources: 106, items: 0, points: 0 }, sectors: [], digest_updated_at: null }
      renderNavCounts()
    }
    render().catch(() => {})
  }
  addEventListener('hashchange', render)
  boot()
  setTimeout(() => { if (!state.catalog?.version || state.catalog.version === '-') boot() }, 2500)
})()
