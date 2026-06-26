// 客户端版本号：取自打包进 tarball 的 package.json。
// 各客户端（sync / mcp / cli）每次请求带上 x-client-version 头，服务端日志记下来，
// 一眼看出谁在跑旧版、该提醒更新。读不到就 "unknown"，不让缺版本号把客户端搞崩。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PKG = join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json");
let v = "unknown";
try { v = JSON.parse(readFileSync(PKG, "utf8")).version || "unknown"; } catch {}
export const CLIENT_VERSION = v;

// 采集流水线代次：影响【从 raw 抽出什么】的不向后兼容改动 +1。
// 客户端把它存进 .brain-state.json；升级后若发现存档代次更低，会一次性重收受影响的历史（见 sync.mjs reconcilePipeline）。
//   1 → 初代。
//   2 → slim 保留 Codex token_count（之前整丢）→ 重收 Codex 历史以补回 token 用量统计。
//   3 → ① redact 不再误伤数值型 token 计数（input_tokens 等 ≥8 位曾被抹成 [REDACTED_SECRET]、还破坏 JSON →
//        重度 Codex 用户 token 统计为 0）；② slim 每北京日留末条 token_count、parse 作差 → Codex token 按天精确。
//        两者都只能从本机原文捞回 → 重收 Codex 历史。
//   4 → slim 不再把 session_history *.md 文档当 tool 输出截成头尾 3KB（之前 >3KB 的文档中段全丢）。
//        原文还在 upload_folders → 重收 session_history *.md 以补回整篇正文。
export const PIPELINE_VERSION = 4;
