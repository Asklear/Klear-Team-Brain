// 撤回：把某条 session 从真相库删掉（git rm + commit）。只允许撤【自己 producer-id】的 —— base 前缀必须等于
// 调用者的 member.id。诚实告知：默认只从 HEAD 移除，git 历史里仍可考古（要彻底抹需另做历史重写，慎重）。
import { join, relative } from "node:path";
import { readdirSync, unlinkSync } from "node:fs";
import { commit } from "./gitstore.mjs";
import { log } from "../core/log.mjs";

export async function retract(truthDir, payload, member) {
  const id = payload?.id;
  if (!id) throw new Error("missing id");
  const base = `${member.id}-${id}`;           // 只能撤自己的：前缀锁死成调用者 id
  const removed = [];
  const stack = [join(truthDir, "spaces")];
  while (stack.length) {
    const d = stack.pop();
    let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of es) {
      if (e.name === ".git") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (e.name === `${base}.jsonl` || e.name === `${base}.md`) {
        try { unlinkSync(p); removed.push(relative(truthDir, p)); } catch {}
      }
    }
  }
  if (!removed.length) return { removed: [] };
  const sha = await commit(truthDir, {
    name: member.name, email: member.email || `${member.id}@team-brain`,
    message: `retract ${base}`, paths: removed,
  });
  log.info("retract", { who: member.id, id, files: removed.length, commit: sha });
  return { removed, commit: sha };
}
