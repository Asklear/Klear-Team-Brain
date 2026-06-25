// 逐条排除（opt-out）：本机名单，采集常驻上传前据此跳过；viewer 增删。纯本机文件，不上传。
// 按 session id 或源文件绝对路径匹配（id 跨机器稳定；file 是本机路径）。
// 与 viewer 同进程 → viewer 改了名单，daemon 下一轮即生效，无需重启。
import { readFileSync, writeFileSync } from "node:fs";

let FILE = null;
let entries = [];                 // [{ id?, file?, intent?, at }]
const byId = new Set(), byFile = new Set();

function reindex() { byId.clear(); byFile.clear(); for (const e of entries) { if (e.id) byId.add(e.id); if (e.file) byFile.add(e.file); } }

export function loadOptout(path) {
  FILE = path;
  try { entries = (JSON.parse(readFileSync(path, "utf8")).entries) || []; } catch { entries = []; }
  reindex();
}
function save() { if (!FILE) return; try { writeFileSync(FILE, JSON.stringify({ v: 1, entries })); } catch {} }

export function isOptedOut(id, file) { return !!((id && byId.has(id)) || (file && byFile.has(file))); }
export function addOptout(e) {
  if (!e || (!e.id && !e.file)) return;
  if (isOptedOut(e.id, e.file)) return;
  entries.push({ id: e.id || null, file: e.file || null, intent: e.intent || null, at: Date.now() });
  reindex(); save();
}
export function removeOptout({ id, file }) {
  entries = entries.filter((e) => !((id && e.id === id) || (file && e.file === file)));
  reindex(); save();
}
export function listOptout() { return entries.slice(); }
