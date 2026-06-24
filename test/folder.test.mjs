import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { normalizeFolder, saniSeg } from "../core/coord.mjs";

const UP = ["/u/repo1-test", "/u/playground/ai-work-space"];

test("normalizeFolder: cwd 在 upload_folder 下 → basename(根)/子路径", () => {
  assert.equal(normalizeFolder("/u/repo1-test/cao/test", UP), "repo1-test/cao/test");
});

test("normalizeFolder: cwd 就是 upload_folder 根", () => {
  assert.equal(normalizeFolder("/u/repo1-test", UP), "repo1-test");
});

test("normalizeFolder: upload_folder 支持前导 ~", () => {
  assert.equal(
    normalizeFolder(`${homedir()}/Documents/brain/project`, ["~/Documents/brain"]),
    "brain/project",
  );
});

test("normalizeFolder: 嵌套 upload_folder 取最长匹配", () => {
  assert.equal(
    normalizeFolder("/u/playground/ai-work-space/mcp", UP),
    "ai-work-space/mcp",
  );
});

test("normalizeFolder: 不在任何 upload_folder 下 → basename 兜底", () => {
  assert.equal(normalizeFolder("/somewhere/else/proj", UP), "proj");
});

test("normalizeFolder: 特殊字符被 sani 归一", () => {
  assert.equal(normalizeFolder("/u/repo1-test/my project", UP), "repo1-test/my-project");
});

// finding 6：新算的 folder 必须与"迁移脚本从旧 space_key 反推"对得上。
// 旧 space_key = local__<person>__<seg>__<seg>...（seg 都 sani 过），反推 = 去前缀、__→/。
function reverseFromOldSpaceKey(spaceKey) {
  const m = spaceKey.match(/^local__[^_]+(?:__(.+))?$/);
  return m && m[1] ? m[1].split("__").join("/") : "";
}
test("finding 6：normalizeFolder 与旧 space_key 反推一致（clean 名）", () => {
  const cwd = "/u/repo1-test/cao/test/repo1-spec016d/docs/adr";
  const fresh = normalizeFolder(cwd, UP);
  const oldKey = "local__user2__" + ["repo1-test", "cao", "test", "repo1-spec016d", "docs", "adr"].map(saniSeg).join("__");
  assert.equal(fresh, reverseFromOldSpaceKey(oldKey));
  assert.equal(fresh, "repo1-test/cao/test/repo1-spec016d/docs/adr");
});
