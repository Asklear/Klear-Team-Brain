// 把一条 session 的 jsonl 还原成可读对话（深挖用）。比直接喂原始 json 省 token。
// 自动嗅探 Claude Code / Codex 两种格式。
import { textOf, codexText, detectTool } from "./parse.mjs";

export function transcript(content, cap = 20000, tool) {
  const kind = tool || detectTool(content);
  const out = kind === "session-history-md" ? sessionHistoryLines(content)
    : kind === "codex" ? codexLines(content) : claudeLines(content);
  let s = out.join("\n\n");
  if (s.length > cap) s = s.slice(0, cap) + "\n\n…（已截断，全文更长）";
  return s || "（无可读对话）";
}

function claudeLines(content) {
  const out = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    const t = textOf(o);
    if (!t) continue;
    if (o.type === "user" && t.startsWith("<")) continue; // 跳过系统/工具回填
    out.push(`**${o.type === "user" ? "用户" : "助手"}**：${t.replace(/\s+/g, " ").trim()}`);
  }
  return out;
}

// Codex：优先用干净的事件级对话（event_msg）；若没有则回退原始消息（response_item）。
function codexLines(content) {
  const evt = [], raw = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload;
    if (o.type === "event_msg") {
      if (p?.type === "user_message" && p.message && !p.message.startsWith("<"))
        evt.push(`**用户**：${p.message.replace(/\s+/g, " ").trim()}`);
      else if (p?.type === "agent_message" && p.message)
        evt.push(`**助手**：${p.message.replace(/\s+/g, " ").trim()}`);
    } else if (o.type === "response_item" && p?.type === "message") {
      const t = codexText(p);
      if (!t || (p.role === "user" && t.startsWith("<")) || p.role === "developer") continue;
      if (p.role === "user" || p.role === "assistant")
        raw.push(`**${p.role === "user" ? "用户" : "助手"}**：${t.replace(/\s+/g, " ").trim()}`);
    }
  }
  return evt.length ? evt : raw;
}

function sessionHistoryLines(content) {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "session_history_markdown") {
      const md = o.content || o.markdown || "";
      return md ? [md] : [];
    }
  }
  return content.trim() ? [content] : [];
}
