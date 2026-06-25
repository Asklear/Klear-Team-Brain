// localExec：服务器进程内的 MCP 执行器 —— 直接调 query.mjs（零自打 HTTP）。
// 每个方法【逐路对齐】server.mjs 里对应的 REST 路由体（同样的归一/脱敏/传参），
// 返回值与该端点同形 → mcp/tools.mjs 的格式化对 stdio / HTTP 两边逐字一致。
// 不变量：read 出口必过 redactReadable；只读、不暴露 ingest；sessions/stats 透传 roster/registry。
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeRelPath, safeSegment } from "../core/safe.mjs";
import { redactReadable } from "../core/redact.mjs";
import { grepTruth, findTruth, lsTruth, logTruth, sessionsTruth, statsTruth, spaceStatsTruth } from "./query.mjs";
import { readSpaceMeta } from "./space.mjs";
import { clientFor, ctxFor } from "../core/repohost.mjs";

// ctx：{ TRUTH, registry, roster, githubToken, resolvePath, resolveSpace } —— 后四个由 server.mjs 注入
// （resolvePath/resolveSpace 是 server.mjs 里的别名/历史坐标兜底闭包，复用以免重写归一逻辑）。
export function makeLocalExec({ TRUTH, registry, roster, githubToken, resolvePath, resolveSpace }) {
  return {
    async grep({ q, space, context, raw }) {
      const r = await grepTruth(TRUTH, {
        pattern: q || "", context, ignoreCase: true,
        space: space ? resolveSpace(space) : undefined, raw: !!raw,
      });
      return { matches: r.matches, truncated: r.truncated };
    },

    find({ name, path, limit }) {
      return findTruth(TRUTH, {
        name: name || undefined,
        path: path ? resolvePath(path) : undefined,
        limit,
      });
    },

    read({ path, offset, limit }) {
      const rel = resolvePath(path || "");
      const abs = safeRelPath(TRUTH, rel, "path");
      if (!existsSync(abs)) throw new Error("not found");
      if (statSync(abs).isDirectory()) throw new Error("是目录，请用 ls");
      let text = redactReadable(readFileSync(abs, "utf8"));   // 出口脱敏（不变量）
      const off = Math.max(0, Number(offset) || 0);
      const lim = Number(limit) || 0;
      if (off || lim) text = text.split("\n").slice(off, lim ? off + lim : undefined).join("\n");
      return { path: rel, text };
    },

    ls({ path }) {
      const rel = resolvePath(path || "");   // 默认 "spaces" 由 tools.mjs handler 统一兜；这里与 REST /ls 同形透传
      const top = !rel || rel === "spaces";
      let r;
      try { r = lsTruth(TRUTH, { path: rel }); }
      catch (e) { if (!top) throw e; r = { path: rel, type: "dir", entries: [] }; }   // spaces 还没建也别崩
      if (top && Array.isArray(r.entries)) {
        const stats = spaceStatsTruth(TRUTH);
        for (const e of r.entries) { const s = stats[e.name]; if (s) Object.assign(e, s); }
      }
      return r;
    },

    async log({ space, author, since, grep, limit }) {
      const commits = await logTruth(TRUTH, {
        space: space || undefined, since: since || undefined,
        author: author || undefined, grep: grep || undefined, limit, registry,
      });
      return { commits };
    },

    sessions({ author, space, since, until, limit }) {
      return sessionsTruth(TRUTH, {
        author: author || undefined, space: space || undefined,
        since: since || undefined, until: until || undefined, limit, roster, registry,
      });
    },

    stats({ by, split, metric, since, until, space, author, tool, limit, offset }) {
      return statsTruth(TRUTH, {
        by: by || undefined, split: split || undefined, metric: metric || undefined,
        since: since || undefined, until: until || undefined,
        space: space ? resolveSpace(space) : undefined,
        author: author || undefined, tool: tool || undefined, limit, offset, roster, registry,
      });
    },

    async github({ space_key, path, ref }) {
      safeSegment(space_key || "", "space_key");
      const meta = readSpaceMeta(TRUTH, space_key);
      const client = clientFor(meta.provider);
      if (!meta.owner || !meta.repo || !client) throw new Error("该 space 无可现拉的代码坐标");
      const ctx = ctxFor(registry, meta, githubToken);
      if (!ctx.token) throw new Error(meta.provider === "github"
        ? "该 space 无可用 GitHub PAT（registry 未配，且无全局 GITHUB_TOKEN）"
        : `该 space 无可用 ${meta.provider} token（registry 未配该实例/项目）`);
      if (path) {
        const content = await client.fileContent(meta.owner, meta.repo, path, ref || undefined, ctx);
        return { space_key, path, ref: ref || "default", content };
      }
      const csp = join(TRUTH, "spaces", space_key, "code-state.md");
      return { space_key, code_state: existsSync(csp) ? readFileSync(csp, "utf8") : "（尚无 code-state，等首次 4h 轮询）" };
    },
  };
}
