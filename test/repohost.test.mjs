import test from "node:test";
import assert from "node:assert/strict";
import * as gitlab from "../core/gitlab.mjs";
import * as gitea from "../core/gitea.mjs";
import { clientFor, ctxFor } from "../core/repohost.mjs";

// 用一个可换的 fetch 桩捕获请求 URL/headers，并返回预设 JSON —— 纯测 URL 构造 + 形状归一，不触网。
function stub(payload) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: opts?.headers || {} });
    return { ok: true, status: 200, json: async () => payload, text: async () => "" };
  };
  return calls;
}
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

test("gitlab: 项目 id = URL-encode 完整路径（子组 /→%2F）+ PRIVATE-TOKEN 头", async () => {
  const calls = stub([{ name: "main" }, { name: "dev" }]);
  const out = await gitlab.listBranches("mygroup/sub", "proj", { token: "T", baseUrl: "https://gitlab.com" });
  assert.equal(calls[0].url, "https://gitlab.com/api/v4/projects/mygroup%2Fsub%2Fproj/repository/branches?per_page=100");
  assert.equal(calls[0].headers["private-token"], "T");
  assert.deepEqual(out, [{ name: "main" }, { name: "dev" }]);
});

test("gitlab: latestCommit 归一 id/committed_date → sha/date", async () => {
  stub([{ id: "abc123", message: "fix: x", committed_date: "2026-06-01T00:00:00Z" }]);
  const c = await gitlab.latestCommit("g", "r", "main", { token: "T", baseUrl: "https://gl" });
  assert.deepEqual(c, { sha: "abc123", message: "fix: x", date: "2026-06-01T00:00:00Z" });
});

test("gitlab: openPulls = MR，iid→number / source·target_branch→head·baseRef", async () => {
  const calls = stub([{ iid: 7, title: "MR", source_branch: "feat", target_branch: "main" }]);
  const out = await gitlab.openPulls("g", "r", { token: "T", baseUrl: "https://gl" });
  assert.match(calls[0].url, /\/merge_requests\?state=opened&per_page=50$/);
  assert.deepEqual(out, [{ number: 7, title: "MR", headRef: "feat", baseRef: "main" }]);
});

test("gitlab: fileContent 路径整体编码 + base64 解码", async () => {
  const calls = stub({ content: b64("hello world"), encoding: "base64" });
  const txt = await gitlab.fileContent("g", "r", "src/a b.txt", "main", { token: "T", baseUrl: "https://gl" });
  assert.match(calls[0].url, /\/repository\/files\/src%2Fa%20b\.txt\?ref=main$/);
  assert.equal(txt, "hello world");
});

test("gitlab: listRepos 从 path_with_namespace 拆 owner/repo + visibility→private", async () => {
  stub([{ path_with_namespace: "grp/sub/proj", default_branch: "main", visibility: "private" },
        { path_with_namespace: "grp/open", default_branch: "trunk", visibility: "public" }]);
  const out = await gitlab.listRepos("grp", { token: "T", baseUrl: "https://gl" });
  assert.deepEqual(out, [
    { owner: "grp/sub", repo: "proj", default_branch: "main", private: true },
    { owner: "grp", repo: "open", default_branch: "trunk", private: false },
  ]);
});

test("gitea: base=/api/v1，鉴权头 token，commit 形状同 github", async () => {
  const calls = stub([{ sha: "deadbeef", commit: { message: "msg", committer: { date: "2026-06-02T00:00:00Z" } } }]);
  const c = await gitea.latestCommit("o", "r", "main", { token: "GT", baseUrl: "https://gitea.example.com/" });
  assert.equal(calls[0].url, "https://gitea.example.com/api/v1/repos/o/r/commits?sha=main&limit=1");
  assert.equal(calls[0].headers.authorization, "token GT");
  assert.deepEqual(c, { sha: "deadbeef", message: "msg", date: "2026-06-02T00:00:00Z" });
});

test("clientFor / ctxFor: 分发 + 解 token/baseUrl", () => {
  assert.equal(clientFor("gitlab"), gitlab);
  assert.equal(clientFor("gitea"), gitea);
  assert.equal(clientFor("nope"), null);
  const reg = { gitlab: { instances: [{ host: "gl.io", base_url: "https://gl.io", token: "INST", groups: ["g"] }] } };
  const ctx = ctxFor(reg, { provider: "gitlab", host: "gl.io", owner: "g", repo: "r" }, "FB");
  assert.equal(ctx.token, "INST");
  assert.equal(ctx.baseUrl, "https://gl.io");
  assert.deepEqual(ctxFor({}, { provider: "github", owner: "o", repo: "r" }, "FB"), { token: "FB" });
});
