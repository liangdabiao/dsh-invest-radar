// 系统提示注入：投资雷达工作流硬规则（方法论细节在 news-digest 技能里）。
export const SYSTEM_RULES = `## 投资雷达（invest-radar）

用户要「看资讯 / 看某赛道近况 / 刷新看板 / 追踪全球产业链信号」时：

**流程**：先 invest_news(action="status") 看数据新鲜度 → 旧了或没有就 fetch（抓取是纯数据操作，失败源会如实返回）→ list 读目标赛道最新新闻 → 按 news-digest 技能提炼「今日要点」+ 中文标题翻译 → digest_save 存档（面板立即可见）。

**硬规则**：要点必须带 refs 溯源（原文 URL）；不推荐个股、不给买卖建议；输出末尾附「以上为行业资讯聚合，不构成投资建议」。海外源在国内网络下大量失败属正常，如实报告「X/Y 源成功」，建议用户配代理后再刷新。`

export function systemSection() {
  return {
    name: 'invest-radar:workflow',
    order: 110,
    text: SYSTEM_RULES,
  }
}
