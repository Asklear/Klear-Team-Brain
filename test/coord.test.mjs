import test from "node:test";
import assert from "node:assert/strict";
import { parseRemote } from "../core/coord.mjs";

test("parseRemote: git@ SSH 形式", () => {
  assert.deepEqual(parseRemote("git@github.com:coldestlin/bossa.git"), {
    host: "github.com", owner: "coldestlin", repo: "bossa",
  });
});

test("parseRemote: https 形式", () => {
  assert.deepEqual(parseRemote("https://github.com/owner/repo.git"), {
    host: "github.com", owner: "owner", repo: "repo",
  });
});

test("parseRemote: gitlab 子组（owner 含中间段）", () => {
  assert.deepEqual(parseRemote("https://gitlab.com/group/sub/repo.git"), {
    host: "gitlab.com", owner: "group/sub", repo: "repo",
  });
});

test("parseRemote: 非法/空 → null", () => {
  assert.equal(parseRemote(""), null);
  assert.equal(parseRemote("not-a-url"), null);
});
