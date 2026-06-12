import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTruth } from "../server/gitstore.mjs";
import { migrate } from "../scripts/migrate-m3.mjs";
import { normalizeFolder } from "../core/coord.mjs";

// 造一张旧卡片 + 原文，落到 spaces/<space>/sessions/<branch>/<pid>-<id>.{md,jsonl}
function putSession(spacesDir, space, branch, pid, id, { space_key } = {}) {
  const d = join(spacesDir, space, "sessions", branch);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, `${pid}-${id}.md`),
    `---\nid: ${id}\nproducer_id: ${pid}\nspace_key: ${space_key || space}\nbranch: ${branch}\n---\n# 干活\n\n**结论**：ok\n`);
  writeFileSync(join(d, `${pid}-${id}.jsonl`), "{}\n");
}

function buildOld() {
  const truth = mkdtempSync(join(tmpdir(), "tb-mig-"));
  initTruth(truth);
  const s = join(truth, "spaces");
  // 1) 已登记 github 空间（带 aliases / agentdocs / files —— 都该清掉）
  putSession(s, "github__coldestlin__bossa", "main", "hank", "g1");
  writeFileSync(join(s, "github__coldestlin__bossa", "space.yaml"), "kind: code\nhome: github\nref: github/coldestlin/bossa\naliases:\n  - local__hank__old\n");
  mkdirSync(join(s, "github__coldestlin__bossa", "agentdocs", "hank"), { recursive: true });
  writeFileSync(join(s, "github__coldestlin__bossa", "agentdocs", "hank", "CLAUDE.md"), "x");
  mkdirSync(join(s, "github__coldestlin__bossa", "files"), { recursive: true });
  writeFileSync(join(s, "github__coldestlin__bossa", "files", "spec.md"), "x");
  // 2) 未登记 github 空间 → 降级
  putSession(s, "github__random__x", "main", "gee", "g2");
  // 3) 本地碎 space → 归并
  putSession(s, "local__hank__bossa-test__cao", "no-branch", "hank", "l1", { space_key: "local__hank__bossa-test__cao" });
  // 4) vault
  putSession(s, "team__vault", "no-branch", "tqt", "v1", { space_key: "team__vault" });
  return truth;
}

const REG = { github: { orgs: [{ org: "coldestlin" }], repos: [] } };

test("migrate: 全量结构迁移正确", () => {
  const truth = buildOld();
  const s = join(truth, "spaces");
  migrate(truth, REG, { apply: true });

  // 已登记 github 保留 + 新 schema + 无 aliases/agentdocs/files
  const ghYaml = readFileSync(join(s, "github__coldestlin__bossa", "space.yaml"), "utf8");
  assert.match(ghYaml, /type: github/);
  assert.match(ghYaml, /via: org/);
  assert.doesNotMatch(ghYaml, /aliases/);
  assert.ok(!existsSync(join(s, "github__coldestlin__bossa", "agentdocs")));
  assert.ok(!existsSync(join(s, "github__coldestlin__bossa", "files")));
  assert.ok(existsSync(join(s, "github__coldestlin__bossa", "sessions", "main", "hank-g1.md")));

  // 未登记 github 降级到 local__gee（folder=random/x），原空间删
  assert.ok(!existsSync(join(s, "github__random__x")));
  const geeCard = readFileSync(join(s, "local__gee", "sessions", "main", "gee-g2.md"), "utf8");
  assert.match(geeCard, /space_key: local__gee/);
  assert.match(geeCard, /folder: random\/x/);

  // 本地碎片归并到 local__hank（folder=bossa-test/cao），与 normalizeFolder 同形
  assert.ok(!existsSync(join(s, "local__hank__bossa-test__cao")));
  const hankCard = readFileSync(join(s, "local__hank", "sessions", "no-branch", "hank-l1.md"), "utf8");
  assert.match(hankCard, /space_key: local__hank/);
  assert.match(hankCard, /folder: bossa-test\/cao/);
  assert.equal(normalizeFolder("/up/bossa-test/cao", ["/up/bossa-test"]), "bossa-test/cao"); // finding 6

  // vault 降级到 local__tqt（folder=vault），原空间删
  assert.ok(!existsSync(join(s, "team__vault")));
  assert.match(readFileSync(join(s, "local__tqt", "sessions", "no-branch", "tqt-v1.md"), "utf8"), /folder: vault/);
});

test("migrate: demote 时 md+jsonl 按 .md 的 producer_id 配对搬（连字符 id 不拆散）", () => {
  const truth = mkdtempSync(join(tmpdir(), "tb-mig2-"));
  initTruth(truth);
  const s = join(truth, "spaces");
  // 未登记的 github 空间（REG 只登记 coldestlin org）→ 降级；producer id 含连字符
  putSession(s, "github__someorg__proj", "main", "fake-hank", "u1");
  migrate(truth, REG, { apply: true });
  // 两个文件都落到 local__fake-hank（不是被文件名 split 错拆成 local__fake）
  assert.ok(existsSync(join(s, "local__fake-hank", "sessions", "main", "fake-hank-u1.md")));
  assert.ok(existsSync(join(s, "local__fake-hank", "sessions", "main", "fake-hank-u1.jsonl")));
  assert.ok(!existsSync(join(s, "local__fake")));            // 没被错误拆桶
  assert.ok(!existsSync(join(s, "github__someorg__proj")));  // 原空间已删
});

test("migrate: 仓转移 remap —— 旧 owner 空间改名/并入 Asklear，不降级", () => {
  const truth = mkdtempSync(join(tmpdir(), "tb-mig3-"));
  initTruth(truth);
  const s = join(truth, "spaces");
  putSession(s, "github__coldestlin__bossa", "main", "hank", "b1", { space_key: "github__coldestlin__bossa" });
  putSession(s, "github__FakeHank__test", "main", "gee", "t1", { space_key: "github__FakeHank__test" });
  putSession(s, "github__Asklear__test-pipeline", "main", "tqt", "p1", { space_key: "github__Asklear__test-pipeline" });

  const reg = {
    github: { orgs: [{ org: "Asklear" }], repos: [] },
    moved: [
      { from: "coldestlin/bossa", to: "Asklear/bossa" },
      { from: "FakeHank/test", to: "Asklear/test-pipeline" },
    ],
  };
  migrate(truth, reg, { apply: true });

  // bossa 改名到 Asklear/bossa（旧空间没了），space_key/ref/space.yaml 都对
  assert.ok(!existsSync(join(s, "github__coldestlin__bossa")));
  const bcard = readFileSync(join(s, "github__Asklear__bossa", "sessions", "main", "hank-b1.md"), "utf8");
  assert.match(bcard, /space_key: github__Asklear__bossa/);
  const byaml = readFileSync(join(s, "github__Asklear__bossa", "space.yaml"), "utf8");
  assert.match(byaml, /type: github/); assert.match(byaml, /ref: github\/Asklear\/bossa/); assert.match(byaml, /via: org/);

  // FakeHank/test 并入已存在的 Asklear/test-pipeline（并入来的 + 原有的 都在）
  assert.ok(!existsSync(join(s, "github__FakeHank__test")));
  assert.ok(existsSync(join(s, "github__Asklear__test-pipeline", "sessions", "main", "gee-t1.md")));
  assert.ok(existsSync(join(s, "github__Asklear__test-pipeline", "sessions", "main", "tqt-p1.md")));
});

test("migrate: merge 碰撞去重 —— 同一 session 在新旧两空间，留 .jsonl 更全的那份", () => {
  const truth = mkdtempSync(join(tmpdir(), "tb-mig4-"));
  initTruth(truth);
  const s = join(truth, "spaces");
  // 目标已有该 session（短 jsonl）
  const a = join(s, "github__Asklear__test-pipeline", "sessions", "main");
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "tqt-dup.md"), "---\nproducer_id: tqt\nspace_key: github__Asklear__test-pipeline\n---\n# x\n");
  writeFileSync(join(a, "tqt-dup.jsonl"), "short\n");
  // 源（FakeHank/test，仓转移→test-pipeline）有同一 session，jsonl 更大（更全）
  const f = join(s, "github__FakeHank__test", "sessions", "main");
  mkdirSync(f, { recursive: true });
  writeFileSync(join(f, "tqt-dup.md"), "---\nproducer_id: tqt\nspace_key: github__FakeHank__test\n---\n# x\n");
  writeFileSync(join(f, "tqt-dup.jsonl"), "much longer and more complete content\n");

  const reg = { github: { orgs: [{ org: "Asklear" }], repos: [] }, moved: [{ from: "FakeHank/test", to: "Asklear/test-pipeline" }] };
  const r = migrate(truth, reg, { apply: true });

  assert.equal(r.deduped, 1);                                  // 报告去重 1 条
  const dest = join(s, "github__Asklear__test-pipeline", "sessions", "main");
  assert.equal(readFileSync(join(dest, "tqt-dup.jsonl"), "utf8"), "much longer and more complete content\n"); // 留了更全的
  assert.ok(!existsSync(join(s, "github__FakeHank__test")));   // 源空间已删
});

test("migrate: 只有文档碎片、无 session 的人 → 不留空 local 桶", () => {
  const truth = mkdtempSync(join(tmpdir(), "tb-mig5-"));
  initTruth(truth);
  const s = join(truth, "spaces");
  const frag = join(s, "local__ghost__notes");          // ghost 只有 files/ 碎片，没 session
  mkdirSync(join(frag, "files"), { recursive: true });
  writeFileSync(join(frag, "files", "x.md"), "doc");
  migrate(truth, REG, { apply: true });
  assert.ok(!existsSync(join(s, "local__ghost")));        // 没留空桶
  assert.ok(!existsSync(join(s, "local__ghost__notes"))); // 碎片也删了
});

test("migrate: 幂等 —— dry-run 再跑无破坏性动作", () => {
  const truth = buildOld();
  migrate(truth, REG, { apply: true });
  const r2 = migrate(truth, REG, { apply: false });   // dry-run 第二遍
  // 第二遍不应再有 move/merge/demote/remove 动作（碎片/未登记空间都没了）
  const destructive = r2.actions.filter((a) => /move|merge|demote|remove|→ local/.test(a));
  assert.equal(destructive.length, 0, `第二遍仍有破坏性动作:\n${destructive.join("\n")}`);
});
