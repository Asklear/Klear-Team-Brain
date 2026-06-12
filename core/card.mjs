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
