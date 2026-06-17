// 把一条 session 的 jsonl 还原成可读对话（深挖用）。比直接喂原始 json 省 token。
// 自动嗅探 Claude Code / Codex 两种格式。
import { textOf, codexText, detectTool } from "./parse.mjs";

// 规整一条消息文本：保留换行（→ 保住 markdown 结构：标题/列表/表格/代码块），
// 只去行尾空白、把 3+ 连续空行压成 1 个空行。⚠️ 不要 \s+→空格，那会把 markdown 压成一坨。
const tidy = (t) => String(t).replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

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
    out.push(`**${o.type === "user" ? "用户" : "助手"}**：\n${tidy(t)}`);
  }
  return out;
}

// Codex：response_item/output_text 保留完整换行和 markdown 结构；
// event_msg/agent_message 是事件流版本，Codex 自身在序列化时去掉了换行（压成单行）。
// 所以当 response_item 的助手消息含换行时，优先用 raw（结构化）；否则回退 evt（事件流）。
function codexLines(content) {
  const evt = [], raw = [];
  let rawHasStructure = false;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const p = o.payload;
    // phase=commentary 是助手的过程旁白（"我先看一下X"），标成「助手·过程」便于前端默认折叠；
    // final_answer / 无 phase → 普通「助手」。Claude Code 无 phase，不受影响。
    const asstLabel = (ph) => (ph === "commentary" ? "助手·过程" : "助手");
    if (o.type === "event_msg") {
      if (p?.type === "user_message" && p.message && !p.message.startsWith("<"))
        evt.push(`**用户**：\n${tidy(p.message)}`);
      else if (p?.type === "agent_message" && p.message)
        evt.push(`**${asstLabel(p.phase)}**：\n${tidy(p.message)}`);
    } else if (o.type === "response_item" && p?.type === "message") {
      const t = codexText(p);
      if (!t || (p.role === "user" && t.startsWith("<")) || p.role === "developer") continue;
      if (p.role === "user") raw.push(`**用户**：\n${tidy(t)}`);
      else if (p.role === "assistant") {
        raw.push(`**${asstLabel(p.phase)}**：\n${tidy(t)}`);
        if (t.includes("\n")) rawHasStructure = true;
      }
    }
  }
  // response_item 助手消息含换行 → 有完整 markdown，用 raw；否则回退 evt
  if (rawHasStructure) return raw;
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
