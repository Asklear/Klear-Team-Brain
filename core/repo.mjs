// 从 cwd 算 repo 身份。优先 git toplevel（不管在哪个子目录开 session 都稳定）；
// 非 git / 目录已消失 → 回退 basename，标 anchor=topic（话题级，无代码锚）。
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { existsSync } from "node:fs";

export function resolveRepo(cwd) {
  if (!cwd) return { repo: "-", anchor: "none" };
  if (existsSync(cwd)) {
    try {
      // execFileSync 走 argv，不拼 shell —— 避免 cwd 里的特殊字符注入
      const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
      if (top) return { repo: basename(top), anchor: "repo" };
    } catch { /* 不是 git 仓 */ }
  }
  return { repo: basename(cwd), anchor: "topic" };
}
