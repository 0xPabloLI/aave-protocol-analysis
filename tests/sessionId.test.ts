/**
 * Session-Id machine fallback (`slots/session-id.md` 的最小实现)。
 *
 * 兜底的价值全在边界行为上，因此这里锁的是边界而不是 happy path：
 *   - id 格式固定 `yyyymmdd-<slug>-<6hex>`，slug 清洗后仍为空时退化为 `task`；
 *   - 已有 Session-Id trailer 时绝不追加第二个（amend 叠加双 id 会让两侧精确查询都失效）；
 *   - 无活跃 session 时 commit-msg 必须静默放行；active.json 坏掉时必须非 0 退出
 *     （坏的兜底状态比没有兜底更危险）；
 *   - 状态目录走 `git-common-dir`，所有 worktree 共享同一份登记表。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendTrailer,
  formatSessionId,
  isValidSessionId,
  readActive,
  slugifyTask,
  stateDir,
  writeActive,
} from "../scripts/session-id.mjs";

const NOW = new Date("2026-11-18T00:00:00Z");

test("formatSessionId: fixed date + sanitized slug + hex", () => {
  assert.equal(
    formatSessionId(NOW, "AAV 449 Fix!", "abc123"),
    "20261118-aav-449-fix-abc123"
  );
});

test("slugifyTask: empty or symbol-only task falls back to `task`", () => {
  assert.equal(slugifyTask(""), "task");
  assert.equal(slugifyTask("!!!"), "task");
  assert.equal(slugifyTask("已中文名称"), "task");
});

test("slugifyTask: long names are capped at 24 chars", () => {
  assert.equal(slugifyTask("a".repeat(60)), "a".repeat(24));
});

test("isValidSessionId: rejects malformed ids", () => {
  assert.equal(isValidSessionId("20261118-aav-449-abc123"), true);
  assert.equal(isValidSessionId("20261118-abc123"), false);
  assert.equal(isValidSessionId("20261118-aav-449-XYZ123"), false);
  assert.equal(isValidSessionId(""), false);
});

test("appendTrailer: appends one trailer with a blank separator", () => {
  assert.equal(
    appendTrailer("fix: thing", "20261118-aav-449-abc123"),
    "fix: thing\n\nSession-Id: 20261118-aav-449-abc123\n"
  );
});

test("appendTrailer: never adds a second trailer", () => {
  const msg = "fix: thing\n\nSession-Id: 20261118-aav-449-abc123\n";
  assert.equal(appendTrailer(msg, "20261118-other-task-def456"), msg);
});

test("appendTrailer: keeps comment lines from commit templates", () => {
  const msg = "fix: thing\n\n# Please enter the commit message\n";
  assert.equal(
    appendTrailer(msg, "20261118-aav-449-abc123"),
    "fix: thing\n\n# Please enter the commit message\n\nSession-Id: 20261118-aav-449-abc123\n"
  );
});

test("stateDir: lives under the shared git-common-dir", () => {
  assert.equal(stateDir("/repo/.git"), "/repo/.git/session-pilot");
});

test("writeActive + read: round-trips the active record", () => {
  const common = join(mkdtempSync(join(tmpdir(), "session-id-")), ".git");
  mkdirSync(common, { recursive: true });
  writeActive(common, {
    id: "20261118-aav-449-abc123",
    task: "aav-449",
    baseline: "deadbee",
  });
  const raw = readFileSync(join(stateDir(common), "active.json"), "utf8");
  assert.match(raw, /"id": "20261118-aav-449-abc123"/);
});

test("active.json with an invalid id is rejected loudly", () => {
  const common = join(mkdtempSync(join(tmpdir(), "session-id-")), ".git");
  mkdirSync(stateDir(common), { recursive: true });
  writeFileSync(
    join(stateDir(common), "active.json"),
    JSON.stringify({ id: "not-an-id" })
  );
  assert.throws(() => readActive(common), /invalid Session-Id/);
});

test("readActive returns null when no session is active", () => {
  const common = join(mkdtempSync(join(tmpdir(), "session-id-")), ".git");
  mkdirSync(common, { recursive: true });
  assert.equal(readActive(common), null);
});

test("commit-msg hook is wired into husky", () => {
  const hook = readFileSync(join(process.cwd(), ".husky/commit-msg"), "utf8");
  assert.match(hook, /commit-msg-session-id\.mjs/);
  assert.match(hook, /exit 1/);
});

/**
 * 回归点：`commit-msg-session-id.mjs` 结束于 `-session-id.mjs`，
 * 早先的 `endsWith("session-id.mjs")` 主入口守卫会把被 import 的 CLI 也当成主程序执行，
 * 于是 hook 在无活跃 session 时也会打印 usage 并以 2 退出——等于每次提交都被拦。
 */
function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "session-hook-"));
  const res = spawnSync("git", ["init", "-q"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0);
  return dir;
}

test("hook: no active session is a silent no-op with exit 0", () => {
  const repo = tempRepo();
  const msg = join(repo, "msg.txt");
  writeFileSync(msg, "feat: x\n");
  const res = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts/commit-msg-session-id.mjs"), msg],
    {
      cwd: repo,
      encoding: "utf8",
    }
  );
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "");
  assert.equal(res.stderr.trim(), "");
  assert.equal(readFileSync(msg, "utf8"), "feat: x\n");
});

test("hook: active session appends the trailer", () => {
  const repo = tempRepo();
  const idRes = spawnSync(
    process.execPath,
    [
      join(process.cwd(), "scripts/session-id.mjs"),
      "start",
      "--task",
      "hook test",
    ],
    {
      cwd: repo,
      encoding: "utf8",
    }
  );
  assert.equal(idRes.status, 0);
  const id = idRes.stdout.trim();
  const msg = join(repo, "msg.txt");
  writeFileSync(msg, "feat: x\n");
  const res = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts/commit-msg-session-id.mjs"), msg],
    {
      cwd: repo,
      encoding: "utf8",
    }
  );
  assert.equal(res.status, 0);
  assert.equal(readFileSync(msg, "utf8"), `feat: x\n\nSession-Id: ${id}\n`);
});

test("CLI: end exits 0 and clears the active record", () => {
  const repo = tempRepo();
  const start = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts/session-id.mjs"), "start", "--task", "t"],
    {
      cwd: repo,
      encoding: "utf8",
    }
  );
  assert.equal(start.status, 0);
  const end = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts/session-id.mjs"), "end"],
    { cwd: repo, encoding: "utf8" }
  );
  assert.equal(end.status, 0);
  const idAfter = spawnSync(
    process.execPath,
    [join(process.cwd(), "scripts/session-id.mjs"), "id"],
    { cwd: repo, encoding: "utf8" }
  );
  assert.equal(idAfter.status, 1);
});
