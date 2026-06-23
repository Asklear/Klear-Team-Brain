import test from "node:test";
import assert from "node:assert/strict";
import { decideSpaceKey, isGitHubHost, loadRegistry, patFor, hasGithub, hasAnyRemote, tokenFor, providerOf, spaceKeyFor } from "../core/registry.mjs";

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
  assert.deepEqual(r, { github: { orgs: [], repos: [] }, gitlab: { instances: [] }, gitea: { instances: [] }, moved: [] });
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

/* ---------------- GitLab / Gitea 多 provider ---------------- */
const MULTI = {
  github: { orgs: [{ org: "Asklear" }], repos: [] },
  gitlab: {
    instances: [{
      host: "gitlab.com", token: "GL_INST",
      groups: [{ group: "mygroup", token: "GL_GROUP" }],
      projects: [{ owner: "solo", repo: "thing", token: "GL_PROJ" }],
    }, {
      host: "git.corp.internal", base_url: "https://git.corp.internal", token: "GL_CORP",
      groups: ["platform"],
    }],
  },
  gitea: {
    instances: [{
      host: "gitea.example.com", base_url: "https://gitea.example.com", token: "GT_INST",
      orgs: [{ org: "team" }],
      repos: ["someone/tool"],
    }],
  },
};

test("decideSpaceKey: gitlab 子组项目 → gitlab space（host 进 key、owner 拍平、真值看 owner/repo）", () => {
  const d = decideSpaceKey(MULTI, { host: "gitlab.com", owner: "mygroup/sub", repo: "proj" }, "hank");
  assert.equal(d.space_key, "gitlab__gitlab.com__mygroup-sub__proj");
  assert.equal(d.type, "gitlab");
  assert.equal(d.provider, "gitlab");
  assert.equal(d.host, "gitlab.com");
  assert.equal(d.owner, "mygroup/sub");
  assert.equal(d.repo, "proj");
  assert.equal(d.ref, "gitlab.com/mygroup/sub/proj");
  assert.deepEqual(d.registered, { via: "group", org: "mygroup" });
});

test("decideSpaceKey: gitlab 单 project 登记命中", () => {
  const d = decideSpaceKey(MULTI, { host: "gitlab.com", owner: "solo", repo: "thing" }, "h");
  assert.equal(d.space_key, "gitlab__gitlab.com__solo__thing");
  assert.deepEqual(d.registered, { via: "project" });
});

test("decideSpaceKey: gitlab 未登记 group → local", () => {
  assert.equal(decideSpaceKey(MULTI, { host: "gitlab.com", owner: "random", repo: "x" }, "h").type, "local");
});

test("decideSpaceKey: 自建 gitlab 实例（带 base_url）", () => {
  const d = decideSpaceKey(MULTI, { host: "git.corp.internal", owner: "platform", repo: "infra" }, "h");
  assert.equal(d.space_key, "gitlab__git.corp.internal__platform__infra");
  assert.equal(d.base_url, "https://git.corp.internal");
  assert.deepEqual(d.registered, { via: "group", org: "platform" });
});

test("decideSpaceKey: gitea org / 单 repo", () => {
  const a = decideSpaceKey(MULTI, { host: "gitea.example.com", owner: "team", repo: "svc" }, "h");
  assert.equal(a.space_key, "gitea__gitea.example.com__team__svc");
  assert.equal(a.type, "gitea");
  assert.deepEqual(a.registered, { via: "org", org: "team" });
  const b = decideSpaceKey(MULTI, { host: "gitea.example.com", owner: "someone", repo: "tool" }, "h");
  assert.deepEqual(b.registered, { via: "repo" });
});

test("decideSpaceKey: 未配置的 host → local（即使 owner 撞名）", () => {
  assert.equal(decideSpaceKey(MULTI, { host: "gitlab.unknown.io", owner: "mygroup", repo: "x" }, "h").type, "local");
});

test("providerOf: 解析 host → provider/实例", () => {
  assert.equal(providerOf(MULTI, "github.com").provider, "github");
  assert.equal(providerOf(MULTI, "gitlab.com").provider, "gitlab");
  assert.equal(providerOf(MULTI, "gitea.example.com").provider, "gitea");
  assert.equal(providerOf(MULTI, "nope.com"), null);
});

test("tokenFor: gitlab 粒度 project > group > 实例 > fallback", () => {
  assert.equal(tokenFor(MULTI, { provider: "gitlab", host: "gitlab.com", owner: "solo", repo: "thing" }, "FB"), "GL_PROJ");
  assert.equal(tokenFor(MULTI, { provider: "gitlab", host: "gitlab.com", owner: "mygroup/sub", repo: "proj" }, "FB"), "GL_GROUP");
  assert.equal(tokenFor(MULTI, { provider: "gitlab", host: "gitlab.com", owner: "other", repo: "r" }, "FB"), "GL_INST");
  // 关键：未知/未配 gitlab 实例【绝不】回退 github 全局 token（否则会把 GitHub PAT 发给 GitLab host）→ 返回 ""
  assert.equal(tokenFor(MULTI, { provider: "gitlab", host: "missing.com", owner: "x", repo: "y" }, "FB"), "");
});

test("tokenFor: gitlab/gitea 实例无 token 时不外溢 github fallback（返回空）", () => {
  const reg = { gitlab: { instances: [{ host: "gl.io", groups: ["pub"] }] } };  // 实例/scope 都没 token
  assert.equal(tokenFor(reg, { provider: "gitlab", host: "gl.io", owner: "pub", repo: "r" }, "GITHUB_GLOBAL"), "");
});

test("tokenFor: gitea 回退到实例级 token；github 仍走 patFor", () => {
  assert.equal(tokenFor(MULTI, { provider: "gitea", host: "gitea.example.com", owner: "team", repo: "svc" }, "FB"), "GT_INST");
  assert.equal(tokenFor(MULTI, { provider: "github", owner: "Asklear", repo: "anything" }, "FB"), "FB"); // org 无 pat → 全局
});

test("spaceKeyFor: github 保持历史格式（不带 host）", () => {
  assert.equal(spaceKeyFor("github", "github.com", "owner", "repo"), "github__owner__repo");
  assert.equal(spaceKeyFor("gitea", "gitea.x.com", "o", "r"), "gitea__gitea.x.com__o__r");
});

test("hasAnyRemote: 任一 provider 配了就 true", () => {
  assert.ok(hasAnyRemote(MULTI));
  assert.ok(hasAnyRemote({ gitlab: { instances: [{ host: "g.com" }] } }));
  assert.ok(!hasAnyRemote({ github: { orgs: [], repos: [] } }));
  assert.ok(!hasAnyRemote({}));
});

test("decideSpaceKey: github 的 moved 不误伤同名 gitlab 仓", () => {
  const reg = {
    github: { orgs: [{ org: "acme" }], repos: [] },
    gitlab: { instances: [{ host: "gitlab.com", groups: ["acme"] }] },
    moved: [{ from: "acme/widget", to: "acme/widget2" }],
  };
  // github 仓被重定向
  assert.equal(decideSpaceKey(reg, { host: "github.com", owner: "acme", repo: "widget" }, "h").space_key, "github__acme__widget2");
  // 同名 gitlab 仓不受影响（owner/repo 保持原样）
  const gl = decideSpaceKey(reg, { host: "gitlab.com", owner: "acme", repo: "widget" }, "h");
  assert.equal(gl.space_key, "gitlab__gitlab.com__acme__widget");
});
