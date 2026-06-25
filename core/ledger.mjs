// 结果账本（M1 地基）：记录采集常驻对【每条 session 源文件】最终做了什么 —— 上传 / 跳过(原因) / 排除。
// 与 .brain-state.json（只记 mtime 做去重）分开：账本要回答「传了啥 / 没传啥 / 为什么 / 在库哪」，
// 是本机 localhost 查看器（client/viewer.mjs）的唯一数据源。纯本机文件，不上传。
//
// 一条记录 = 一个源文件（key=file 绝对路径）：
//   { file, id, tool, status, reason?, intent?, cwd?, remote?, folder?, branch?,
//     space_key?, server_file?, bytes_raw?, bytes_slim?, work_start?, work_end?,
//     mtime?, recorded_at }
//   status ∈ uploaded | skipped | opted_out          （pending 由 viewer 实时扫描派生，不落账本）
//   reason ∈ gated | excluded | toobig | nointent | subagent | empty | error   （status=skipped 时）
import { readFileSync, writeFileSync } from "node:fs";

let FILE = null;
const map = new Map(); // file -> record

export function loadLedger(path) {
  FILE = path;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    for (const e of j.sessions || []) if (e && e.file) map.set(e.file, e);
  } catch { /* 首次 / 损坏 → 空账本，照常往下走 */ }
}

export function saveLedger() {
  if (!FILE) return;
  try { writeFileSync(FILE, JSON.stringify({ v: 1, sessions: [...map.values()] })); }
  catch { /* 落盘失败不致命：下一轮再写 */ }
}

// 记一条（按 file 合并，保留已知字段、覆盖新值）。rec.file 必填。
export function recordSession(rec) {
  if (!rec || !rec.file) return;
  const prev = map.get(rec.file) || {};
  map.set(rec.file, { ...prev, ...rec, recorded_at: Date.now() });
}

export function allSessions() { return [...map.values()]; }
export function getByFile(file) { return map.get(file) || null; }
export function getById(id) { for (const e of map.values()) if (e.id === id) return e; return null; }
export function ledgerSize() { return map.size; }
