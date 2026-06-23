import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTruth } from "../server/gitstore.mjs";
import { enumAndRegisterOrgRepos, refreshAll } from "../server/codestate.mjs";

function freshTruth() {
  const dir = mkdtempSync(join(tmpdir(), "tb-cs-"));
  initTruth(dir);
  return dir;
}

test("enumAndRegisterOrgRepos: 单 repo 预登记 space.yaml（无 session 也建，无需网络）", async () => {
  const truth = freshTruth();
  const reg = { github: { orgs: [], repos: [{ owner: "haurhi", repo: "finance_qa" }] } };
  const r = await enumAndRegisterOrgRepos(truth, reg, "faketoken");
  assert.equal(r.registered, 1);
  const yaml = readFileSync(join(truth, "spaces", "github__haurhi__finance_qa", "space.yaml"), "utf8");
  assert.match(yaml, /type: github/);
  assert.match(yaml, /ref: github\/haurhi\/finance_qa/);
  assert.match(yaml, /via: repo/);
});

test("enumAndRegisterOrgRepos: 已存在的 space 不覆盖（幂等）", async () => {
  const truth = freshTruth();
  const reg = { github: { orgs: [], repos: [{ owner: "haurhi", repo: "finance_qa" }] } };
  await enumAndRegisterOrgRepos(truth, reg, "t");
  const r2 = await enumAndRegisterOrgRepos(truth, reg, "t");
  assert.equal(r2.registered, 0);   // 第二次什么都不建
});

test("refreshAll: 懒加载 —— 没有 session 的 github space 被跳过（不触网）", async () => {
  const truth = freshTruth();
  // 预登记一个空 github space（无 sessions）
  await enumAndRegisterOrgRepos(truth, { github: { orgs: [], repos: [{ owner: "o", repo: "empty" }] } }, "t");
  // 一个 local space 也不该被 code-state 碰
  mkdirSync(join(truth, "spaces", "local__hank"), { recursive: true });
  writeFileSync(join(truth, "spaces", "local__hank", "space.yaml"), "type: local\nperson: hank\n");
  const out = await refreshAll(truth, { github: { orgs: [], repos: [] } }, "faketoken");   // 不会发网络请求：唯一的 github space 无 session → skip
  const gh = out.find((x) => x.space === "github__o__empty");
  assert.equal(gh.skipped, "no-session");
  assert.ok(!out.some((x) => x.space === "local__hank"));   // local 不进 code-state
});

test("enumAndRegisterOrgRepos: gitlab project / gitea repo 预登记（单仓无需网络）", async () => {
  const truth = freshTruth();
  const reg = {
    gitlab: { instances: [{ host: "gitlab.com", base_url: "https://gitlab.com", projects: [{ owner: "grp/sub", repo: "proj" }] }] },
    gitea: { instances: [{ host: "gitea.x.com", base_url: "https://gitea.x.com", repos: ["team/svc"] }] },
  };
  const r = await enumAndRegisterOrgRepos(truth, reg, "");
  assert.equal(r.registered, 2);
  const gl = readFileSync(join(truth, "spaces", "gitlab__gitlab.com__grp-sub__proj", "space.yaml"), "utf8");
  assert.match(gl, /provider: gitlab/);
  assert.match(gl, /host: gitlab\.com/);
  assert.match(gl, /owner: grp\/sub/);     // 真值（子组）存盘，不是拍平后的 key 段
  assert.match(gl, /repo: proj/);
  assert.match(gl, /ref: gitlab\.com\/grp\/sub\/proj/);
  const gt = readFileSync(join(truth, "spaces", "gitea__gitea.x.com__team__svc", "space.yaml"), "utf8");
  assert.match(gt, /provider: gitea/);
  assert.match(gt, /base_url: https:\/\/gitea\.x\.com/);
});

test("refreshAll: 认 gitlab/gitea 前缀，无 session 一样懒跳过（不触网）", async () => {
  const truth = freshTruth();
  const reg = { gitlab: { instances: [{ host: "gitlab.com", base_url: "https://gitlab.com", projects: [{ owner: "g", repo: "r" }] }] } };
  await enumAndRegisterOrgRepos(truth, reg, "");
  const out = await refreshAll(truth, reg, "");
  const gl = out.find((x) => x.space === "gitlab__gitlab.com__g__r");
  assert.equal(gl.skipped, "no-session");
});
