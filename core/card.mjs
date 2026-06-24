// 卡片 = 真相的派生视图（可重建）：frontmatter（任意键，空值略过）+ 正文。
// M3.1 起正文 = 脱敏后的全文 transcript（不再是「意图+结论」摘要）。
// 脱敏由调用方负责（ingest 用 redactAgent），本函数只做拼装。

// meta = 任意 {key: value}（空值自动略过）；body = 已脱敏正文文本（如全文 transcript）。
export function buildCard(meta, body = "") {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    // 值里的换行会被注入成额外 frontmatter 字段（伪造作者/日期）→ 压成单行
    .map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]+/g, " ")}`);
  return `---\n${lines.join("\n")}\n---\n${body || "（无可读对话）"}\n`;
}

// 从卡片正文读 frontmatter 单字段
export const fm = (txt, k) => (txt.match(new RegExp(`^${k}:\\s*(.*)$`, "m")) || [, ""])[1].trim();

// usage{in,out,cache_r,cache_w} → frontmatter 的 tokens_* 字段（null/无数据 → {}，buildCard 自动略过）。
// ingest（在线）与 rebuild-cards（离线回填）共用，保证两条路写出的字段名/口径一致。tokens_total = 四项之和。
export function usageFields(usage) {
  if (!usage) return {};
  const { in: i = 0, out = 0, cache_r = 0, cache_w = 0 } = usage;
  return { tokens_in: i, tokens_out: out, tokens_cache_r: cache_r, tokens_cache_w: cache_w, tokens_total: i + out + cache_r + cache_w };
}

// 按天明细 days[]（parse 出的 {date,turns,[in,out,cache_r,cache_w]}）→ frontmatter。
// 紧凑成单行 JSON 元组数组：用量已知 → [date,turns,in,out,cache_r,cache_w]；未知 → [date,turns]（区别于真 0）。
// 统计层（statsTruth）按天拆片时读它，让跨天 session 各天各算各的。tokensDaily!="full"（如 Codex 的 "start"，
// token 拆不到天、整条记在开始日）落 tokens_daily 标志，供报表提示「该口径为近似」。
export function daysFields(days, tokensDaily) {
  if (!days || !days.length) return {};
  const tuples = days.map((d) => (d.in === undefined
    ? [d.date, d.turns || 0]
    : [d.date, d.turns || 0, d.in || 0, d.out || 0, d.cache_r || 0, d.cache_w || 0]));
  const out = { days: JSON.stringify(tuples) };
  if (tokensDaily && tokensDaily !== "full") out.tokens_daily = tokensDaily;
  return out;
}

// 从卡片头部读回 days[]（统计层用）。元组长度<6 = 该天用量未知（usage:null，区别于真 0）。无 days 字段 → null。
export function readDays(txt) {
  const raw = fm(txt, "days");
  if (!raw) return null;
  let arr; try { arr = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return arr.map((t) => {
    const [date, turns = 0, i, out, cr, cw] = t;
    const hasU = Array.isArray(t) && t.length >= 6;
    return {
      date: String(date), turns: Number(turns) || 0,
      usage: hasU
        ? { in: i || 0, out: out || 0, cache_r: cr || 0, cache_w: cw || 0, total: (i || 0) + (out || 0) + (cr || 0) + (cw || 0) }
        : null,
    };
  });
}

// 从卡片头部读回 usage 聚合（统计层用）：缺字段当 0，五个字段全缺则返回 null（= 用量未知，区别于真 0）。
export function readUsage(txt) {
  const num = (k) => { const v = fm(txt, k); return v === "" ? null : (Number(v) || 0); };
  const keys = ["tokens_in", "tokens_out", "tokens_cache_r", "tokens_cache_w", "tokens_total"];
  if (keys.every((k) => num(k) === null)) return null;
  return {
    in: num("tokens_in") || 0, out: num("tokens_out") || 0,
    cache_r: num("tokens_cache_r") || 0, cache_w: num("tokens_cache_w") || 0,
    total: num("tokens_total") || 0,
  };
}
