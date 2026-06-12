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
