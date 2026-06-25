import { resolve, sep } from "node:path";

// 路径段安全：上传方给的 space_key / branch / producer.id / id 会直接拼进文件路径，
// 必须挡住路径穿越。单段内若无分隔符，唯一能上跳的只有恰好等于 "." 或 ".."；
// 因此只要禁掉分隔符(/ \ NUL) + 恰好为 "."/".." 即可，既挡穿越又不误伤含点的正常名字（如 v2..final）。
export function safeSegment(s, label = "segment") {
  const v = String(s ?? "");
  if (!v || v === "." || v === ".." || /[/\\\0]/.test(v))
    throw new Error(`unsafe ${label}: ${JSON.stringify(v).slice(0, 60)}`);
  return v;
}

// 文档源标题/库名要进文件名：去掉路径分隔与控制符、压空白、截短到 80；空兜底 untitled。
// 之后仍过 safeSegment（穿越红线，别绕开）。文档镜像各 provider（feishu/notion/google）共用——名字消毒只此一处。
export const saniName = (s, label = "name") =>
  safeSegment((String(s || "").replace(/[/\\\0]/g, "-").replace(/\s+/g, " ").trim() || "untitled").slice(0, 80), label);

// 多段相对路径锁在 root 内：解析成绝对路径后必须仍以 root 为前缀（或恰为 root）。
// 给只读查询（ls/log/grep 的 path 收窄）用——客户端给的 rel 直接落进 root 子树前必过。
export function safeRelPath(root, rel, label = "path") {
  const base = resolve(root);
  const abs = resolve(base, String(rel ?? ""));
  if (abs !== base && !abs.startsWith(base + sep))
    throw new Error(`unsafe ${label}: ${JSON.stringify(rel).slice(0, 80)}`);
  return abs;
}
