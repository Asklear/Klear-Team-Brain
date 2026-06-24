import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSpaceKey, canonicalSpaceKey, canonicalizePath, canonicalizeSubject,
  resolveAuthorQuery, authorMatches,
} from "../core/identity.mjs";

const REG = {
  github: { orgs: [], repos: [] },
  moved: [
    { from: "olduser2/repo2", to: "Asklear/repo2" },
    { from: "olduser1/repo1", to: "Asklear/repo1" },
  ],
};
const ROSTER = { members: [{ id: "user1", name: "username1", git_names: ["username1", "user1"] }] };

test("parseSpaceKey: 含下划线的 repo 不被切坏", () => {
  assert.deepEqual(parseSpaceKey("github__Asklear__repo2"), { owner: "Asklear", repo: "repo2" });
  assert.equal(parseSpaceKey("local__user2"), null);          // 非 github 无 owner/repo
});

test("canonicalSpaceKey: 历史/别名 owner 映射到现位置", () => {
  assert.equal(canonicalSpaceKey(REG, "github__olduser2__repo2"), "github__Asklear__repo2");
  assert.equal(canonicalSpaceKey(REG, "github__olduser1__repo1"), "github__Asklear__repo1");
  // 已是 canonical / 无映射 / 非 github → 原样
  assert.equal(canonicalSpaceKey(REG, "github__Asklear__repo2"), "github__Asklear__repo2");
  assert.equal(canonicalSpaceKey(REG, "local__user1"), "local__user1");
});

test("canonicalizePath: 只改 space 段，其余原样", () => {
  assert.equal(
    canonicalizePath(REG, "spaces/github__olduser2__repo2/sessions/main/user1-x.md"),
    "spaces/github__Asklear__repo2/sessions/main/user1-x.md"
  );
  assert.equal(canonicalizePath(REG, "spaces"), "spaces");     // 顶层不崩
});

test("canonicalizeSubject: log 坐标里的 space_key 就地归一", () => {
  assert.equal(
    canonicalizeSubject(REG, "ingest github__olduser2__repo2/main/user1-rollout-2026-06-01"),
    "ingest github__Asklear__repo2/main/user1-rollout-2026-06-01"
  );
});

test("resolveAuthorQuery + authorMatches: user1 与 username1 等价、命中同一条", () => {
  const byPid = resolveAuthorQuery(ROSTER, "user1");
  const byGit = resolveAuthorQuery(ROSTER, "username1");
  // 两个查询解析到同一 accept 集（同一身份）
  assert.deepEqual([...byPid.accept].sort(), [...byGit.accept].sort());
  const rec = { producerId: "user1", author: "username1" };
  assert.equal(authorMatches(byPid, rec), true);
  assert.equal(authorMatches(byGit, rec), true);
  // 别人不命中
  assert.equal(authorMatches(byPid, { producerId: "user2", author: "username2" }), false);
});

test("authorMatches: 不在花名册的名字走子串兜底", () => {
  const r = resolveAuthorQuery(ROSTER, "rongvc");
  assert.equal(r.fallback, true);
  assert.equal(authorMatches(r, { producerId: "rongvc", author: "gaorongvc" }), true);
});
