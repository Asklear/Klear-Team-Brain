// 入库前脱敏：先挡住最常见的红线（密钥/token）。
// 注意：内容级脱敏（客户名等）尚未解决，属 M2 上传前必须补的一层。
export const RULES = [
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GH]"],   // fine-grained PAT（gh[pousr]_ 规则盖不到）
  [/gh[pousr]_[A-Za-z0-9]{30,}/g, "[REDACTED_GH]"],
  [/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED_KEY]"],
  [/AKIA[0-9A-Z]{16}/g, "[REDACTED_AWS]"],
  [/AIza[0-9A-Za-z_\-]{35}/g, "[REDACTED_GOOGLE]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/(?:Bearer|token|api[_-]?key|password|secret)["'\s:=]+[A-Za-z0-9._\-]{12,}/gi, "[REDACTED_SECRET]"],
];

export const redact = (s) => RULES.reduce((a, [re, to]) => a.replace(re, to), s || "");

// 把本机家目录路径抹成 ~（agent 配置里满是机器级绝对路径，跨人/入库前必须中和）。
export const scrubHome = (s) => (s || "")
  .replace(/\/Users\/[^/\s"'`)]+/g, "~")           // mac
  .replace(/\/home\/[^/\s"'`)]+/g, "~")            // linux
  .replace(/\/root(?=\/|\b)/g, "~")                // linux root
  .replace(/[Cc]:\\Users\\[^\\\s"'`)]+/g, "~");    // windows

// agent 文件离机前的脱敏：密钥/token + 家目录路径。客户端在上传前调用。
export const redactAgent = (s) => scrubHome(redact(s));
