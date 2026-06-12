// 单一投影点：raw session → 派生视图正文。
// ingest（在线落盘）与 scripts/rebuild-cards（离线重建）共用此函数，保证两条路产物一字不差。
// 「换索引方式」的唯一改动面就在这里——调用方（ingest/rebuild）不必动。
// 当前派生 = 脱敏后的【全文 transcript】（无损、可读、可被 grep/read）。
// 未来若换 FTS5/别的：把产物从「正文文本」演进成「索引行」也只改这一处 + 重跑 rebuild。
import { transcript } from "./transcript.mjs";
import { redactAgent } from "./redact.mjs";

// raw = 原始 jsonl 文本；tool 可选（不给则自动嗅探 CC/Codex）。
// 大 cap → 不截断，留全文；redactAgent = 抹密钥/token + 家目录路径（raw 入库不脱敏，派生必须自脱敏）。
export function projectSession(raw, tool) {
  return redactAgent(transcript(raw, 1e9, tool));
}
