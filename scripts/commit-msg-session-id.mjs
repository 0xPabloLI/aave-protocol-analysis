#!/usr/bin/env node
/**
 * commit-msg hook：有活跃 session 时把 Session-Id trailer 写进提交信息。
 * 无活跃 session（或 .git/session-pilot 不存在）时静默退出 0——不阻断提交。
 * 读不出 active.json 时非 0 退出——坏的兜底状态比没有兜底更危险。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { appendTrailer, readActive } from "./session-id.mjs";

function gitCommonDir() {
  const res = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    encoding: "utf8",
  });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

const msgFile = process.argv[2];
if (!msgFile) process.exit(0);

const common = gitCommonDir();
if (!common) process.exit(0);

let active;
try {
  active = readActive(common);
} catch (err) {
  process.stderr.write(`commit-msg: invalid session state — ${err.message}\n`);
  process.exit(1);
}

if (!active) process.exit(0);

const message = readFileSync(msgFile, "utf8");
const next = appendTrailer(message, active.id);
if (next !== message) writeFileSync(msgFile, next);
process.exit(0);
