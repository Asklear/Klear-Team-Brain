// 个人脱敏词表：在内置自动脱敏（core/redact.mjs）【之后】，再把用户自定义的词 / 正则替换为 [REDACTED]。
// 补内置规则覆盖不到的「内容级」敏感信息（客户名、真名、内部代号）。纯本机、不上传；上传前应用，只影响新上传。
import { readFileSync, writeFileSync } from "node:fs";

let FILE = null;
let terms = [];        // [{ pattern, type:'text'|'regex' }]
let compiled = [];     // [RegExp]

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// '/foo/i' → RegExp；普通文本 → 全局字面量。统一带 g 以便 replace-all 与计数。
function toRe(t) {
  if (t.type === "regex") {
    const m = String(t.pattern).match(/^\/(.*)\/([gimsuy]*)$/);
    if (m) return new RegExp(m[1], m[2].includes("g") ? m[2] : m[2] + "g");
    return new RegExp(t.pattern, "g");
  }
  return new RegExp(escapeRe(t.pattern), "g");
}
function compile() { compiled = []; for (const t of terms) { try { compiled.push(toRe(t)); } catch {} } }

export function loadUserRedact(path) {
  FILE = path;
  try { terms = (JSON.parse(readFileSync(path, "utf8")).terms) || []; } catch { terms = []; }
  compile();
}
function save() { if (!FILE) return; try { writeFileSync(FILE, JSON.stringify({ v: 1, terms })); } catch {} }

export function applyUserRedact(text) {
  if (!compiled.length) return text;             // 没词条 → 原样返回（零开销）
  let s = String(text);
  for (const re of compiled) s = s.replace(re, "[REDACTED]");
  return s;
}
export function hasUserRedact() { return compiled.length > 0; }
export function listTerms() { return terms.slice(); }
export function addTerm(t) {
  if (!t || !t.pattern || terms.some((x) => x.pattern === t.pattern)) return;
  terms.push({ pattern: t.pattern, type: t.type === "regex" ? "regex" : "text" });
  save(); compile();
}
export function removeTerm(pattern) { terms = terms.filter((t) => t.pattern !== pattern); save(); compile(); }
// 某词条在给定文本里命中多少次（viewer 显示「本机命中 N 条」用）。
export function countMatches(text, t) { try { const m = String(text).match(toRe(t)); return m ? m.length : 0; } catch { return 0; } }
