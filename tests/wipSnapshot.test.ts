/**
 * WIP 快照（`slots/wip-snapshot.md` 的最小实现）。
 *
 * 锁的是边界而不是 happy path：
 *   - 快照必须**不改变现场**：真实 index 仍为空、工作树文件仍在（`git stash create`
 *     只覆盖跟踪改动，`stash push` 以收走改动为代价，两者都不合格）；
 *   - 未跟踪文件必须进快照——2026-11-18 事故里丢的就是未跟踪内容；
 *   - 干净工作树不制造空 ref；`--dry-run` 只报数量；
 *   - 非 git 目录非 0 退出（快照在错的地方静默通过，等于没有兜底）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../scripts/wip-snapshot.mjs", import.meta.url)
);

const withRepo = (fn: (root: string) => void) => {
  const root = mkdtempSync(join(tmpdir(), "wip-snapshot-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).replace(
      /\n$/,
      ""
    );
  try {
    git(["init", "-q", "-b", "main"]);
    git([
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "commit",
      "--allow-empty",
      "-m",
      "base",
    ]);
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const run = (root: string, args: string[] = []) =>
  execFileSync(process.execPath, [SCRIPT, "--repo", root, ...args], {
    encoding: "utf8",
  });

// CI runner 没有 user.name/user.email；快照必须在那种机器上也能落 ref，
// 所以这里用空的 HOME + 禁 system config 复现「无身份」环境。
const runWithoutIdentity = (root: string) =>
  execFileSync(process.execPath, [SCRIPT, "--repo", root], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, ".no-such-gitconfig"),
    },
  });

const refs = (root: string) =>
  execFileSync("git", ["for-each-ref", "--format=%(refname)", "refs/wip"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

test("clean tree creates no ref", () => {
  withRepo((root) => {
    assert.match(run(root), /clean — nothing to snapshot/);
    assert.deepEqual(refs(root), []);
  });
});

test("captures tracked edits and untracked files without touching index or worktree", () => {
  withRepo((root) => {
    writeFileSync(join(root, "tracked.txt"), "before\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@example.com",
        "-c",
        "user.name=t",
        "commit",
        "-m",
        "add",
      ],
      {
        cwd: root,
      }
    );
    writeFileSync(join(root, "tracked.txt"), "after\n");
    writeFileSync(join(root, "notes.txt"), "untracked body\n");

    run(root, ["--label", "start"]);
    const refsNow = refs(root);
    assert.equal(refsNow.length, 1);
    const ref = refsNow[0];
    assert.equal(
      execFileSync("git", ["show", `${ref}:notes.txt`], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      "untracked body"
    );
    assert.equal(
      execFileSync("git", ["show", `${ref}:tracked.txt`], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      "after"
    );

    // 快照是副本，不是 stash：index 仍为空，工作树改动与未跟踪文件都还在。
    assert.equal(
      execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      ""
    );
    assert.equal(
      readFileSync(join(root, "notes.txt"), "utf8"),
      "untracked body\n"
    );
    assert.match(readFileSync(join(root, "tracked.txt"), "utf8"), /after/);
  });
});

test("dry-run reports paths and writes no ref", () => {
  withRepo((root) => {
    writeFileSync(join(root, "scratch.txt"), "x\n");
    assert.match(run(root, ["--dry-run"]), /dry-run: 1 path/);
    assert.deepEqual(refs(root), []);
  });
});

test("snapshots on a machine with no git identity (CI runner)", () => {
  withRepo((root) => {
    writeFileSync(join(root, "notes.txt"), "body\n");
    runWithoutIdentity(root);
    assert.equal(refs(root).length, 1);
    assert.equal(
      execFileSync("git", ["show", `${refs(root)[0]}:notes.txt`], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      "body"
    );
  });
});

test("exits non-zero outside a git repository", () => {
  const plain = mkdtempSync(join(tmpdir(), "wip-plain-"));
  try {
    assert.throws(
      () =>
        execFileSync(process.execPath, [SCRIPT, "--repo", plain], {
          encoding: "utf8",
          stdio: "pipe",
        }),
      /not a git repository/
    );
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
