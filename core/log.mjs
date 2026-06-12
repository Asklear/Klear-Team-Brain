// 极简分级日志：ISO 时间戳 + 级别 + 消息 + logfmt 风格 key=value 字段。
// 零依赖、打到 stderr（生产 `journalctl -u team-brain` 直收）。
// 级别用 LOG_LEVEL 环境变量调（debug/info/warn/error，默认 info）——低于阈值的丢弃。
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;

// 字段值格式化：空 → "-"；含空格/引号的字符串 → JSON 加引号；其余原样。保证一行可被 grep/logfmt 解析。
const fmtVal = (v) => {
  if (v == null) return "-";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /[\s"=]/.test(s) ? JSON.stringify(s) : s;
};

function emit(level, msg, fields) {
  if (LEVELS[level] < MIN) return;
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  if (fields) for (const [k, v] of Object.entries(fields)) line += ` ${k}=${fmtVal(v)}`;
  console.error(line);
}

export const log = {
  debug: (msg, f) => emit("debug", msg, f),
  info: (msg, f) => emit("info", msg, f),
  warn: (msg, f) => emit("warn", msg, f),
  error: (msg, f) => emit("error", msg, f),
};
