# dsh-invest-radar · 投资雷达

DeepSeek Harness（dsh）插件：A股投资者的全球产业链资讯看板。**12 大赛道一一对应 A股板块**，106 个海外权威 RSS 源本地抓取（去重 + 合规红线过滤），会话模型按 `news-digest` 技能提炼中文「今日要点」+ 标题翻译，侧栏「投资雷达」面板呈现。**零 API key**——提炼由 dsh 会话模型完成。

移植自 [investment-news](https://github.com/simonlin1212/investment-news)（MIT，纯 Python 标准库）。原项目的 claude-cli spawn 层在 dsh 里被更干净地替代：会话模型本身就是那个 LLM。

<img width="2463" height="1398" alt="image" src="https://github.com/user-attachments/assets/7b249bae-a63f-4601-819d-48c33cbabad8" />
<img width="1464" height="1389" alt="image" src="https://github.com/user-attachments/assets/68f487e5-9003-4c0c-86dd-555d0477da98" />
<img width="1662" height="1332" alt="image" src="https://github.com/user-attachments/assets/017788a2-aeff-42c9-af25-422d3bbacef5" />


## 核心功能

- 📡 **本地抓取**：`invest_news(action="fetch")` 并发抓取 106+ 源（40 并发、单源超时可配、失败源如实降级），URL 归一化剥跟踪参数、48h 标题窗去重（跨周栏目不误杀）、26 个红线词过滤（赌博/加密/预测市场/色情），北京时间规整
- ✦ **AI 今日要点**：每赛道 3-5 条中文要点（≤40 字、跨源聚合、突出数字/公司/趋势、**带原文溯源链接**）+ 每条新闻中文标题翻译——由会话模型按技能提炼，`digest_save` 存档后看板立即可见
- 🖥 **看板面板**：概览（数据新鲜度/赛道热度/失败源/定时抓取）、赛道看板（要点卡置顶 + 双语新闻列表 + ↗ 跳原文）、信息源管理（106+ 源健康状态、加源/删源/**临时开关**）
- ⏯ **源开关**：`invest_news(action="sources", sourceAction="enable"/"disable")` 临时停用/恢复某个源（停用 ≠ 删除，fetch 自动跳过）；面板「信息源」页每个源都有 ⏸/▶ 按钮
- ⏰ **定时刷新（两级）**：① 面板概览「定时抓取」——宿主进程内 timer 按 schedule.json 周期抓取原始新闻（不含提炼，DSH 运行期间生效），支持「立即抓一次」；② **全自动（抓+提炼）**——点面板「建全自动定时（抓+提炼）」开新对话，agent 用 DSH 定时任务（schedule_create）按完整流程刷新
- 🔒 **隐私**：抓取在本地完成；生成要点时只有新闻标题（附来源与赛道名）进入会话模型上下文，新闻库与配置都在本机

## 12 赛道

AI/大模型 · 半导体/芯片 · 机器人/自动化 · 汽车/新能源车 · 能源/新能源 · 生物医药/健康 · 航天/太空 · 网络安全 · 科技/互联网 · 消费电子/数码 · 财经/宏观 · 科学/前沿

## 使用流程

1. 面板「刷新看板」（或对话里说"刷新投资雷达"）→ agent：`status` → `fetch` → 逐赛道 `list` → 提炼 → `digest_save`
2. 看板每栏置顶今日要点，点 ↗ 跳原文核实；「信息源」页可加源（RSS）/删源/**临时开关源**（⏸ 停用的源 fetch 跳过）
3. 定时刷新按需选：只要新闻数据自动更新 → 面板「定时抓取」开定时（宿主运行期间生效）；要抓取+提炼全自动 → 点「建全自动定时（抓+提炼）」让 agent 建 dsh 定时任务
4. 海外源在国内网络下**强烈建议配置代理**：Config 的 `proxyUrl`（如 `http://127.0.0.1:7890`），留空则读 `HTTPS_PROXY` 环境变量

## 安装

```bash
dsh plugin add  https://github.com/liangdabiao/dsh-invest-radar 
```

依赖自动安装（仅 `@deepseek-ai/schemastery`；RSS 解析是手写的，零第三方）。数据在 `~/.dsh/invest-radar/`（`DSH_HOME` 可改）。

## 开发

```bash
npm install
npm test                 # 37 项单测：fetcher 去重/解析/时间/红线 26 + store 源开关 8 + schedule 定时 3
npm run build            # client.js → dist/client.js
node scripts/smoke.mjs   # 冒烟：面板 API 全链路（离线 fixture）
node scripts/live.mjs    # 真实抓取冒烟（走代理抓 3 个源验证网络链路）
DSH_HOME=<目录> node scripts/devserver.mjs 5175   # 面板独立预览
```

## 架构

```text
├── src/host.js          invest_news 工具（fetch/list/digest_save/status/sources，源可 enable/disable）+ 装配 + 定时抓取 timer
├── src/systemPrompt.js  工作流硬规则（先 status 后 fetch、要点溯源、源开关、免责声明、定时任务指引）
├── lib/fetcher.js       fetch.py 全量移植：RSS/Atom 手解、URL 归一化、48h 标题窗去重、
│                        红线过滤、北京时间、40 并发池、HTTP(S) 代理 CONNECT 隧道（零依赖）
├── lib/store.js         feed.json / digests.json / sources.user.json（add/remove/disable）/ schedule.json（原子写）
├── lib/sources.default.json  内置 106 源 + 12 赛道 + 红线词（原样移植）
├── lib/api.js           /invest-radar 前缀路由（存档只读 + 源配置含 toggle + 定时抓取 + 静态资源）
├── lib/skills.js        技能提供方
├── skills/news-digest/  提炼方法论（digest.py SYS 展开：要点规范/溯源/红线/免责）
├── client.js → dist/    侧栏入口 + iframe 桥 + 主题/刷新开对话
└── lab/                 面板（瑞士风设计系统，明暗双主题）
```

## 边界与说明

- 只支持 RSS/Atom 源；不支持需要登录/JS 渲染的源
- 本工具是**行业资讯聚合**：呈现动向与领先信号，不是行情数据，**不构成投资建议**
- 抓取失败如实报告（`X/Y 源成功`），不编造没抓到的新闻；单赛道提炼失败不影响其余

## 更新日志

- **0.2.0**（2026-11-11）源开关 + 定时刷新：
  - **源临时开关**：`invest_news(action="sources", sourceAction="enable"/"disable")`——停用 ≠ 删除，停用的源 fetch 自动跳过、清单保留；`sources.user.json` 新增 `disable` 列表，新增 `POST /api/sources/toggle`；面板「信息源」页每行 ⏸/▶ 按钮，停用源置灰 `⏸ OFF`，分组头显示「启用 N/M」
  - 概览页新增「定时抓取」卡片：间隔（6/12/24/48 小时）+ 启用/停用 + 「立即抓一次」
  - 宿主进程内 30s 心跳，到期直跑 fetchAll（纯数据层，自动更新看板新闻列表；AI 要点提炼仍走对话）
  - GET/POST /api/schedule + runNow 钩子；schedule.json 持久化（last_run/last_error/last_count）
  - 「建全自动定时（抓+提炼）」按钮：开新对话让 agent 用 DSH 定时任务（schedule_create）跑完整刷新流程；systemPrompt 注入源开关与定时任务工作流指引
  - 抓取错误与运行状态在卡片状态行可见；换代理后点「立即抓一次」即可验证海外源

## 致谢

- [investment-news](https://github.com/simonlin1212/investment-news)：fetch.py 抓取引擎与去重细节（含 3 个真实 issue 的打磨）、106 源清单、digest 提示词均移植自该项目（MIT）
- [dsh-guizang-design](https://github.com/op7418/dsh-guizang-design)：面板瑞士风设计系统参考
- [linux.do](https://linux.do)：社区支持

## License

MIT



