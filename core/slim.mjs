// 上传前蒸馏（瘦身）v2：按记录类型做「减法」。真相库要的是信号——用户问题 + agent 回答 +
// 「做了哪些动作」的骨架 + 坐标——不是遥测、UI 状态、重复回显、tool 输出全文、图片字节。
// 蒸馏在客户端、上传前；保留 jsonl 事件结构（服务端 parse/project/slice 不变）；完整原文留产出者本机。
// 三类减法：① 整条丢纯遥测/UI；② 去重（同信息存两遍）；③ 狠截 tool 输出 + reasoning/thinking。
// 留：用户/agent 消息、function_call(name+args)、session_meta(含 git)。
//
// 实测背景：单条 316MB（多为内联截图 base64）/ 125MB（海量中等 tool 输出）会撑爆小内存服务器。

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { redactJsonl } from "./redact.mjs";
import { localDay } from "./parse.mjs";

const KB = 1024;
// 图片/裸 base64 大块：文本级先剥（不必 JSON.parse 巨行，省内存；也顺带清掉 reasoning 的 encrypted blob）
const IMG_DATAURI = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g;
const B64_RUN = /[A-Za-z0-9+/]{2048,}={0,2}/g;

const TOOL_HEAD = 2 * KB, TOOL_TAIL = 1 * KB;   // tool 输出 / reasoning / thinking 截留头尾
const ARG_HEAD = 8 * KB, ARG_TAIL = 1 * KB;     // function_call.arguments / tool_use.input（写文件等大入参）

const human = (n) => (n >= KB ? `${Math.round(n / KB)}KB` : `${n}B`);

// 截超长字符串：留头尾、中间标省略量（首尾才看得出"跑了啥命令、结果头尾"）。
function capStr(s, head = TOOL_HEAD, tail = TOOL_TAIL) {
  if (typeof s !== "string" || s.length <= head + tail + 40) return s;
  return s.slice(0, head) + `…[略 ${human(s.length - head - tail)}]…` + s.slice(-tail);
}
// 递归把对象里的字符串都按给定上限截（给 reasoning payload / tool_use.input 这种结构不定的）。
function capDeep(v, head, tail) {
  if (typeof v === "string") return capStr(v, head, tail);
  if (Array.isArray(v)) return v.map((x) => capDeep(x, head, tail));
  if (v && typeof v === "object") { for (const k of Object.keys(v)) v[k] = capDeep(v[k], head, tail); return v; }
  return v;
}

// ---- Codex ----
// token_count 不在这丢：它每轮重发（噪声）但带 session 累计 token 用量（统计要用）→
// slimRaw 单独处理：丢掉中间重复，按【北京日】各留当日最后一条累计快照（见 feedLine/finish）。
const CODEX_DROP_EVENT = new Set([
  "exec_command_end",            // 与 response_item/function_call_output 重复（同命令输出存两遍）
  "exec_command_output_delta",   // 流式增量块，重复
]);
function slimCodex(o) {
  const p = o.payload;
  if (!p || typeof p !== "object") return o;
  switch (o.type) {
    case "turn_context":
      delete p.collaboration_mode;           // 每轮重嵌的整段系统指令 → 留 cwd/git/model 即可
      delete p.base_instructions;
      return o;
    case "event_msg": {
      if (CODEX_DROP_EVENT.has(p.type)) return null;
      if (p.type === "agent_reasoning" && typeof p.text === "string") p.text = capStr(p.text);  // 截推理
      return o;
    }
    case "response_item": {
      const t = p.type;
      if (t === "function_call_output" || t === "custom_tool_call_output") p.output = capStr(p.output);
      else if (t === "function_call" || t === "custom_tool_call") p.arguments = capStr(p.arguments, ARG_HEAD, ARG_TAIL);
      else if (t === "reasoning") { p.content = capDeep(p.content, TOOL_HEAD, TOOL_TAIL); p.summary = capDeep(p.summary, TOOL_HEAD, TOOL_TAIL); }
      // type === "message"：保留正文（图片 base64 已被文本级剥掉）
      return o;
    }
    default:
      return o;                              // session_meta 等：保留（含 git）
  }
}

// ---- Claude Code ----
const CC_DROP = new Set([
  "file-history-snapshot", "mode", "permission-mode", "ai-title", "last-prompt", "task_reminder", "queued-command",
]);
function capContent(c) {                      // tool_result.content：string 或 [{type:text,text}]
  if (typeof c === "string") return capStr(c);
  if (Array.isArray(c)) for (const b of c) { if (b && typeof b.text === "string") b.text = capStr(b.text); }
  return c;
}
function slimCC(o) {
  if (CC_DROP.has(o.type)) return null;
  // session_history 本地 .md：整篇人/agent 写的文档本身就是信号，不能当 tool 输出走兜底 capDeep
  // 截成头尾 3KB（图片/base64 已在 feedLine 文本级剥过；超大文档由 sync 的 MAX_RAW/MAX_UPLOAD 闸门挡）。
  if (o.type === "session_history_markdown" || o.type === "session_history_meta") return o;
  const c = o.message && o.message.content;
  if (Array.isArray(c)) {
    for (const b of c) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "thinking" && typeof b.thinking === "string") b.thinking = capStr(b.thinking);        // 截思考
      else if (b.type === "tool_result") b.content = capContent(b.content);                                 // 截 tool 输出
      else if (b.type === "tool_use" && b.input) b.input = capDeep(b.input, ARG_HEAD, ARG_TAIL);            // 截大入参
      else if (b.type === "image" && b.source) b.source = { type: "omitted", note: "[image omitted]" };     // 剥图
      // type === "text"：保留（用户/agent 正文）
    }
    return o;
  }
  if (o.type !== "user" && o.type !== "assistant" && o.type !== "summary") return capDeep(o, TOOL_HEAD, TOOL_TAIL); // 杂项 CC 记录兜底截
  return o;
}

// 单行蒸馏：图片/base64 文本级先剥（不必 JSON.parse 巨行）→ 按记录类型做减法。
// out 收蒸馏后行；state.tokenCountByDay 按北京日留 Codex token_count 末条快照（每轮重发，按天去重）。
// 拆出来让整文本(slimRaw)和流式逐行(slimRawFile)共用同一套减法，逐行处理与整文处理等价
//（JSONL 单条记录不跨行，IMG/B64 strip 按行做结果一致）。
function feedLine(line, out, state) {
  if (!line || !line.trim()) return;
  const stripped = line
    .replace(IMG_DATAURI, (m) => `[image ${human(m.length)} omitted]`)
    .replace(B64_RUN, (m) => `[blob ${human(m.length)} omitted]`);
  let o; try { o = JSON.parse(stripped); } catch { out.push(capStr(stripped, ARG_HEAD, ARG_TAIL)); return; } // 坏行也别无限长
  const isCodex = o && typeof o === "object" && o.payload && typeof o.payload === "object";
  // token_count 每轮重发（噪声），但带 session 累计用量。按【北京日】留每日最后一条累计快照
  //（而非整条只留末条）→ parse 对相邻日快照作差得每日消耗，Codex token 也能按天精确（见 parseCodexText）。
  if (isCodex && o.type === "event_msg" && o.payload.type === "token_count") { state.tokenCountByDay.set(localDay(o.timestamp) || "_", o); return; }
  const r = isCodex ? slimCodex(o) : slimCC(o);
  if (r === null) return;                     // 整条丢
  out.push(JSON.stringify(r));
}

function finish(out, state) {
  // 每北京日末条 token_count 按日序补回（每活跃日一条、极小；位置不影响 transcript）
  for (const day of [...state.tokenCountByDay.keys()].sort()) out.push(JSON.stringify(state.tokenCountByDay.get(day)));
  // 上传前最后一步：抹密钥/token（保 JSON 结构）→ 真相库 .jsonl 不含密钥，完整原文留本机。
  return redactJsonl(out.join("\n")) + "\n";
}

// raw jsonl 文本 → 蒸馏后的 jsonl 文本。
export function slimRaw(raw) {
  const out = [], state = { tokenCountByDay: new Map() };
  for (const line of String(raw || "").split("\n")) feedLine(line, out, state);
  return finish(out, state);
}

// 流式版：逐行读文件、单行蒸馏，永不把整文件持有成一个超大字符串
//（codex rollout 可达数百 MB，readFileSync(utf8) 会撞 V8 ~512MB 串上限/OOM；
//  蒸馏后通常只剩几 MB，瓶颈只在"先整读"这一步——流式绕开它）。
// 注意：单条 JSONL 记录仍逐行读成字符串，极端单行超大(>几百MB)仍可能吃内存，但 rollout 是每事件一行、单行有界。
export async function slimRawFile(file) {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const out = [], state = { tokenCountByDay: new Map() };
  try { for await (const line of rl) feedLine(line, out, state); } finally { rl.close(); }
  return finish(out, state);
}
