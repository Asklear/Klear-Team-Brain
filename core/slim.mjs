// 上传前蒸馏（瘦身）v2：按记录类型做「减法」。真相库要的是信号——用户问题 + agent 回答 +
// 「做了哪些动作」的骨架 + 坐标——不是遥测、UI 状态、重复回显、tool 输出全文、图片字节。
// 蒸馏在客户端、上传前；保留 jsonl 事件结构（服务端 parse/project/slice 不变）；完整原文留产出者本机。
// 三类减法：① 整条丢纯遥测/UI；② 去重（同信息存两遍）；③ 狠截 tool 输出 + reasoning/thinking。
// 留：用户/agent 消息、function_call(name+args)、session_meta(含 git)。
//
// 实测背景：单条 316MB（多为内联截图 base64）/ 125MB（海量中等 tool 输出）会撑爆小内存服务器。

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
const CODEX_DROP_EVENT = new Set([
  "token_count",                 // 纯限流计数遥测
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

// raw jsonl 文本 → 蒸馏后的 jsonl 文本。
export function slimRaw(raw) {
  const text = String(raw || "")
    .replace(IMG_DATAURI, (m) => `[image ${human(m.length)} omitted]`)
    .replace(B64_RUN, (m) => `[blob ${human(m.length)} omitted]`);
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { out.push(capStr(line, ARG_HEAD, ARG_TAIL)); continue; } // 坏行也别无限长
    const r = (o && typeof o === "object" && o.payload && typeof o.payload === "object") ? slimCodex(o) : slimCC(o);
    if (r === null) continue;                 // 整条丢
    out.push(JSON.stringify(r));
  }
  return out.join("\n") + "\n";
}
