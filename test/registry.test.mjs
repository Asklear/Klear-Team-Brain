import test from "node:test";
import assert from "node:assert/strict";
import { decideSpaceKey, isGitHubHost, loadRegistry, patFor, hasGithub } from "../core/registry.mjs";

const REG = {
  github: {
    orgs: [{ org: "coldestlin", pat_ref: "p1" }],
    repos: [{ owner: "haurhi", repo: "finance_qa", pat_ref: "p2" }],
  },
};
const gh = (owner, repo) => ({ host: "github.com", owner, repo });

test("命中已登记 org → github space", () => {
  const d = decideSpaceKey(REG, gh("coldestlin", "bossa"), "hank");
  assert.equal(d.space_key, "github__coldestlin__bossa");
  assert.equal(d.type, "github");
  assert.equal(d.ref, "github/coldestlin/bossa");
  assert.deepEqual(d.registered, { via: "org", org: "coldestlin" });
});

test("命中已登记单 repo → github space", () => {
  const d = decideSpaceKey(REG, gh("haurhi", "finance_qa"), "hank");
  assert.equal(d.space_key, "github__haurhi__finance_qa");
  assert.deepEqual(d.registered, { via: "repo" });
});

test("有 GitHub remote 但未登记 → local（关键：杜绝随手 clone 冒出 space）", () => {
  const d = decideSpaceKey(REG, gh("random", "repo"), "hank");
  assert.equal(d.space_key, "local__hank");
  assert.equal(d.type, "local");
  assert.equal(d.person, "hank");
});

test("非 GitHub host 即使 owner 撞上 org → local（决策 4 收窄）", () => {
  const d = decideSpaceKey(REG, { host: "gitlab.com", owner: "coldestlin", repo: "bossa" }, "hank");
  assert.equal(d.space_key, "local__hank");
});

test("无 remote → local", () => {
  assert.equal(decideSpaceKey(REG, null, "gee").space_key, "local__gee");
});

test("字符串简写形式的 registry 也认", () => {
  const reg = { github: { orgs: ["coldestlin"], repos: ["haurhi/finance_qa"] } };
  assert.equal(decideSpaceKey(reg, gh("coldestlin", "x"), "h").type, "github");
  assert.equal(decideSpaceKey(reg, gh("haurhi", "finance_qa"), "h").type, "github");
  assert.equal(decideSpaceKey(reg, gh("haurhi", "other"), "h").type, "local");
});

test("decideSpaceKey: moved 重定向 —— 客户端还指旧 owner，也落到现位置（Asklear）", () => {
  const reg = {
    github: { orgs: [{ org: "Asklear" }], repos: [] },
    moved: [{ from: "coldestlin/bossa", to: "Asklear/bossa" }],
  };
  // 没改 remote 的客户端仍上报 coldestlin/bossa
  const d = decideSpaceKey(reg, gh("coldestlin", "bossa"), "hank");
  assert.equal(d.space_key, "github__Asklear__bossa");
  assert.equal(d.type, "github");
  assert.deepEqual(d.registered, { via: "org", org: "Asklear" });
  // 已改 remote 的客户端上报 Asklear/bossa → 同样结果
  assert.equal(decideSpaceKey(reg, gh("Asklear", "bossa"), "hank").space_key, "github__Asklear__bossa");
  // 没在 moved/registry 里的旧仓 → 仍 local
  assert.equal(decideSpaceKey(reg, gh("coldestlin", "other"), "hank").type, "local");
});

test("loadRegistry: 保留 moved 段", () => {
  const r = loadRegistry("/nonexistent/registry.yaml");
  assert.deepEqual(r.moved, []);
});

test("isGitHubHost", () => {
  assert.ok(isGitHubHost("github.com"));
  assert.ok(!isGitHubHost("gitlab.com"));
  assert.ok(!isGitHubHost(""));
});

test("loadRegistry: 缺文件 → 空名单（不崩）", () => {
  const r = loadRegistry("/nonexistent/registry.yaml");
  assert.deepEqual(r, { github: { orgs: [], repos: [] }, moved: [] });
});

const PATREG = {
  github: {
    orgs: [{ org: "myorg", pat: "ORG_PAT" }, "noPatOrg"],
    repos: [{ owner: "haurhi", repo: "finance_qa", pat: "REPO_PAT" }, { owner: "pub", repo: "open" }],
  },
};

test("patFor: org 一把覆盖其全部 repo", () => {
  assert.equal(patFor(PATREG, "myorg", "anything", "FB"), "ORG_PAT");
  assert.equal(patFor(PATREG, "myorg", "another-repo", "FB"), "ORG_PAT");
});

test("patFor: 单独登记的 repo 用自己那把", () => {
  assert.equal(patFor(PATREG, "haurhi", "finance_qa", "FB"), "REPO_PAT");
});

test("patFor: 没配 pat 的条目 → 回退全局", () => {
  assert.equal(patFor(PATREG, "pub", "open", "FB"), "FB");        // repo 条目无 pat
  assert.equal(patFor(PATREG, "noPatOrg", "x", "FB"), "FB");      // org 字符串形式无 pat
  assert.equal(patFor(PATREG, "stranger", "y", "FB"), "FB");      // 完全没登记
});

test("hasGithub", () => {
  assert.ok(hasGithub(PATREG));
  assert.ok(!hasGithub({ github: { orgs: [], repos: [] } }));
  assert.ok(!hasGithub({}));
});
