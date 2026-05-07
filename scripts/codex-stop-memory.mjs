import fs from "node:fs";
import { spawnSync } from "node:child_process";
import {
  AVATAR_PORT,
  BRIDGE_PORT,
  PROCESS_FILE,
  request
} from "./memory-runtime.mjs";

function readRegistry() {
  try {
    if (!fs.existsSync(PROCESS_FILE)) {
      return {};
    }

    const parsed = JSON.parse(fs.readFileSync(PROCESS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function removeRegistry() {
  try {
    fs.rmSync(PROCESS_FILE, { force: true });
  } catch {
    // 清理登记文件失败不影响杀进程，别让一张纸拦住关灯。
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid, label, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      label,
      pid,
      stopped: false,
      reason: "invalid-pid"
    };
  }

  if (!isAlive(pid)) {
    return {
      label,
      pid,
      stopped: false,
      reason: "not-running"
    };
  }

  try {
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
      } catch {
        process.kill(pid, signal);
      }
    } else {
      process.kill(pid, signal);
    }
    return {
      label,
      pid,
      stopped: true,
      signal
    };
  } catch (error) {
    return {
      label,
      pid,
      stopped: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function findPidsByPort(port) {
  if (process.platform === "win32") {
    return [];
  }

  const result = spawnSync("lsof", ["-ti", `tcp:${port}`], {
    encoding: "utf8"
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return result.stdout
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function stopByHttp(port, label) {
  const pids = findPidsByPort(port);
  if (pids.length > 0) {
    return {
      label,
      port,
      stopped: true,
      fallback: "lsof",
      pids: pids.map((pid) => killPid(pid, `${label}:${port}`))
    };
  }

  const response = await request(`http://127.0.0.1:${port}/health`, {
    timeout: 800
  }).catch(() => null);

  if (!response?.ok) {
    return {
      label,
      port,
      stopped: false,
      reason: "not-running"
    };
  }

  return {
    label,
    port,
    stopped: false,
    reason: "running-but-pid-unknown"
  };
}

async function main() {
  const registry = readRegistry();
  const results = [];

  for (const [label, record] of Object.entries(registry)) {
    results.push(killPid(Number(record?.pid), label));
  }

  if (!registry.avatar) {
    results.push(await stopByHttp(AVATAR_PORT, "avatar"));
  }

  if (!registry.bridge) {
    results.push(await stopByHttp(BRIDGE_PORT, "bridge"));
  }

  removeRegistry();
  process.stdout.write(`${JSON.stringify({
    ok: true,
    processFile: PROCESS_FILE,
    results
  }, null, 2)}\n`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
