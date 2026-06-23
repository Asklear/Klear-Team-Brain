// 入库前脱敏：先挡住最常见的红线（密钥/token）。规则取自 gitleaks 默认规则集的高置信子集（curated、低误伤）。
// 注意：内容级脱敏（客户名等）尚未解决，属 M2 上传前必须补的一层。
//
// 「前缀型」规则：令牌有独特前缀/结构，整段换占位符、不涉及引号 → 对 JSON 行文本也安全（客户端 redactJsonl 复用）。
export const PREFIX_RULES = [
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GH]"],   // fine-grained PAT（gh[pousr]_ 规则盖不到）
  [/gh[pousr]_[A-Za-z0-9]{30,}/g, "[REDACTED_GH]"],
  [/glpat-[A-Za-z0-9_-]{20}/g, "[REDACTED_GITLAB]"],
  [/sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, "[REDACTED_KEY]"],   // OpenAI/Anthropic（含 sk-proj-/sk-ant- 新前缀）
  [/(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}/g, "[REDACTED_AWS]"],
  [/AIza[0-9A-Za-z_\-]{35}/g, "[REDACTED_GOOGLE]"],
  [/ya29\.[0-9A-Za-z_\-]{20,}/g, "[REDACTED_GOOGLE]"],   // Google OAuth access token
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_SLACK]"],
  [/[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, "[REDACTED_STRIPE]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
];

// 「赋值型」兜底（贪婪，吃掉「键名+值」整段）：只给 markdown/纯文本用（不保 JSON 结构）。
const GENERIC_RULE = [/(?:Bearer|token|api[_-]?key|password|secret)["'\s:=]+[A-Za-z0-9._\-]{12,}/gi, "[REDACTED_SECRET]"];
export const RULES = [...PREFIX_RULES, GENERIC_RULE];

export const redact = (s) => RULES.reduce((a, [re, to]) => a.replace(re, to), s || "");

// JSON 行文本专用的赋值规则：只换【右值】、保留 键名+分隔符+引号 → 不破坏 JSON 结构
// （GENERIC_RULE 会连键名带分隔符一起吃掉，用在 JSONL 上会把 {"k":"v"} 改成非法 JSON）。
// 覆盖 shell(export FOO=…) / yaml(foo: …) / json("foo":"…") / .env；值字符类排除 空白/引号/反斜杠/括号
// → 在 JSON 转义文本里遇到收尾的 \" 即停，也不会二次吞掉刚生成的占位符。值≥8 字符才动（压低误伤）。
const ASSIGN_JSONL = /(["']?\b[\w.-]*(?:secret|token|passwd|password|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|credential)[\w.-]*["']?\s*[:=]\s*\\?["']?)([^\s"'`,;)\\\[\]{}]{8,})/gi;
// URL 内嵌凭据 scheme://user:pass@host → 只抹 pass，保留 scheme/user/host（够看出连了哪）。字符类排引号/反斜杠 → 不越 JSON 串。
const URL_CRED = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`\\]+):([^\s:@/"'`\\]+)@/gi;

// 客户端上传前对 slim 后的 JSONL 文本脱敏（前缀规则 + 保结构赋值规则 + URL 内嵌口令）。
// 目的：真相库的 .jsonl 原文本身就不含密钥——不再只靠派生 .md / 读出口（redactReadable）兜底；完整原文留产出者本机。
export const redactJsonl = (s) =>
  PREFIX_RULES.reduce((a, [re, to]) => a.replace(re, to), String(s || ""))
    .replace(ASSIGN_JSONL, (_m, head) => head + "[REDACTED_SECRET]")
    .replace(URL_CRED, (_m, head) => head + ":[REDACTED_SECRET]@");

// 把本机家目录路径抹成 ~（agent 配置里满是机器级绝对路径，跨人/入库前必须中和）。
export const scrubHome = (s) => (s || "")
  .replace(/\/Users\/[^/\s"'`)]+/g, "~")           // mac
  .replace(/\/home\/[^/\s"'`)]+/g, "~")            // linux
  .replace(/\/root(?=\/|\b)/g, "~")                // linux root
  .replace(/[Cc]:\\Users\\[^\\\s"'`)]+/g, "~");    // windows

// agent 文件离机前的脱敏：密钥/token + 家目录路径。客户端在上传前调用。
export const redactAgent = (s) => scrubHome(redact(s));

// 出库读取（/read）专用：文件若以 YAML frontmatter 开头，只对【正文】做 secret 脱敏，
// frontmatter 仅过家目录擦除、不跑 secret 规则。
// 原因：frontmatter 是服务端生成的结构化元数据，node_token / obj_token / file_token 等是飞书公开 id
// （非密钥），但含 "token" 字样会被上面的 secret 规则误伤成 [REDACTED_SECRET]，连键名都被吃掉。
// 正文（含 .jsonl 原文，无 frontmatter → 整体走 redactAgent）该挡的密钥照常挡。
export const redactReadable = (s) => {
  const str = String(s ?? "");
  const m = str.match(/^(---\n[\s\S]*?\n---\n?)([\s\S]*)$/);
  return m ? scrubHome(m[1]) + redactAgent(m[2]) : redactAgent(str);
};
