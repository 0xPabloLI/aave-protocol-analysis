#!/usr/bin/env node
/**
 * Session-Id 机器兜底（core slots/session-id.md 的本地最小实现）。
 *
 * 用法：
 *   node scripts/session-id.mjs start --task "aav-449" [--baseline <sha>]
 *   node scripts/session-id.mjs id
 *   node scripts/session-id.mjs end
 *
 * 状态文件：<git-common-dir>/session-pilot/active.json（所有 worktree 共享，不入库）
 * 登记表：  <git-common-dir>/session-pilot/pilot-log.md
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const TRAILER_KEY = "Session-Id";

export function slugifyTask(task) {
  const slug = String(task || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 24) || "task";
}

export function formatSessionId(now, task, hex) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}-${slugifyTask(task)}-${hex}`;
}

export function isValidSessionId(id) {
  return /^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6}$/.test(String(id || ""));
}

/** 追加 trailer；已有 Session-Id 时原样返回（amend 不得叠第二个 id）。 */
export function appendTrailer(message, id) {
  const text = String(message || "");
  const hasTrailer = text
    .split("\n")
    .some((line) => new RegExp(`^${TRAILER_KEY}:\\s*\\S`).test(line.trim()));
  if (hasTrailer) return text;
  const trimmed = text.replace(/\s+$/, "");
  return `${trimmed}\n\n${TRAILER_KEY}: ${id}\n`;
}

export function stateDir(gitCommonDir) {
  return join(gitCommonDir, "session-pilot");
}

export function readActive(gitCommonDir) {
  const file = join(stateDir(gitCommonDir), "active.json");
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!isValidSessionId(parsed?.id)) {
    throw new Error(`active.json has an invalid Session-Id: ${parsed?.id}`);
  }
  return parsed;
}

export function writeActive(gitCommonDir, record) {
  const dir = stateDir(gitCommonDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "active.json"),
    `${JSON.stringify(record, null, 2)}\n`
  );
}

export function appendLog(gitCommonDir, line) {
  const dir = stateDir(gitCommonDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "pilot-log.md");
  const header = existsSync(file) ? "" : "# Session Pilot Log\n\n";
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, `${prev}${header}${line}\n`);
}

function gitCommonDir() {
  const res = spawnSync("git", ["rev-parse", "--git-common-dir"], {
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error("not a git repository");
  return res.stdout.trim();
}

function gitHead() {
  const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    encoding: "utf8",
  });
  return res.status === 0 ? res.stdout.trim() : "none";
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const common = gitCommonDir();

  if (cmd === "start") {
    const taskIdx = rest.indexOf("--task");
    const task = taskIdx >= 0 ? rest[taskIdx + 1] : "session";
    const baseIdx = rest.indexOf("--baseline");
    const baseline = baseIdx >= 0 ? rest[baseIdx + 1] : gitHead();
    const id = formatSessionId(
      new Date(),
      task,
      randomBytes(3).toString("hex")
    );
    const record = { id, task, baseline, startedAt: new Date().toISOString() };
    writeActive(common, record);
    appendLog(common, `- start  ${id}  baseline=${baseline}  task=${task}`);
    process.stdout.write(`${id}\n`);
    return 0;
  }

  if (cmd === "id") {
    const active = readActive(common);
    if (!active) {
      process.stderr.write("no active session\n");
      return 1;
    }
    process.stdout.write(`${active.id}\n`);
    return 0;
  }

  if (cmd === "end") {
    const active = readActive(common);
    if (!active) {
      process.stderr.write("no active session\n");
      return 1;
    }
    appendLog(common, `- end    ${active.id}  head=${gitHead()}`);
    rmSync(join(stateDir(common), "active.json"));
    return 0;
  }

  process.stderr.write(
    "usage: session-id.mjs <start|id|end> [--task name] [--baseline sha]\n"
  );
  return 2;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
