// 权威真相库的 git 操作。所有写入串行化（一个提交队列），且用异步 git 不阻塞事件循环。
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { log } from "../core/log.mjs";

const pexec = promisify(execFile);
const git = (dir, args) => pexec("git", ["-C", dir, ...args]).then((r) => r.stdout.trim());

export function initTruth(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  try { execFileSync("git", ["-C", dir, "rev-parse", "--git-dir"], { stdio: "ignore" }); }
  catch { execFileSync("git", ["-C", dir, "init", "-q"]); }
}

// 串行队列：即使某次失败也不卡住后面的。失败会原样 reject 给调用方（ingest → HTTP 非 200 →
// 客户端不 mark seen、下轮重试），队列这条 catch 只为不阻塞后续任务 —— 但要落一条日志，
// 否则提交失败（git 冲突 / 磁盘满 / 锁）在服务端完全不可见。
let chain = Promise.resolve();
export function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch((e) => { log.warn("提交队列任务失败（不卡后续，调用方会收到该错误）", { err: e?.message || String(e) }); });
  return run;
}

// 提交（author = 提交者）。给了 paths 就只 add 这些（并发 ingest 互不串台、归属正确）；
// 没给则 add -A（codestate 等单写场景兼容）。只看暂存区判断有无改动 → 无则跳过返回 null。
export function commit(dir, { name, email, message, paths }) {
  return enqueue(async () => {
    if (paths && paths.length) await git(dir, ["add", "--", ...paths]);
    else await git(dir, ["add", "-A"]);
    const staged = await git(dir, ["diff", "--cached", "--name-only"]);
    if (!staged) return null;
    await git(dir, [
      "-c", `user.name=${name}`, "-c", `user.email=${email}`,
      "commit", "-q", "-m", message, "--author", `${name} <${email}>`,
    ]);
    return git(dir, ["rev-parse", "HEAD"]);
  });
}

// --- 只读：单文件的 git 历史 / 某个历史版本（agent 配置深挖用，纯读，不进提交队列）---
// relPath 相对真相库根、posix 分隔（如 spaces/<key>/agentdocs/<pid>/CLAUDE.md）。
export async function fileHistory(dir, relPath) {
  try {
    const { stdout } = await pexec("git", ["-C", dir, "log", "--format=%h%x1f%aI%x1f%an%x1f%s", "--", relPath]);
    return stdout.split("\n").filter(Boolean).map((l) => {
      const [sha, date, author, subject] = l.split("\x1f");
      return { sha, date, author, subject };
    });
  } catch { return []; }
}
export async function fileAtRev(dir, rev, relPath) {
  try { return (await pexec("git", ["-C", dir, "show", `${rev}:${relPath}`])).stdout; }
  catch { return null; }
}
