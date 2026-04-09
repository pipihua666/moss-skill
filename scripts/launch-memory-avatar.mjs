import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = 4173;
const SERVER_URL = `http://${HOST}:${PORT}`;
const DEV_LOG = path.join(os.tmpdir(), "moss-avatar-dev.log");
const START_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 500;

function quotePerson(person) {
  return `${SERVER_URL}/?person=${encodeURIComponent(person)}`;
}

function request(pathname = "/") {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: HOST,
        port: PORT,
        path: pathname,
        timeout: 2000
      },
      (res) => {
        const { statusCode = 0 } = res;
        res.resume();
        resolve(statusCode >= 200 && statusCode < 500);
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);
  });
}

async function isServerReady() {
  try {
    return await request("/");
  } catch {
    return false;
  }
}

async function waitForServer() {
  const deadline = Date.now() + START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isServerReady()) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return false;
}

function readRecentLog() {
  try {
    if (!fs.existsSync(DEV_LOG)) {
      return "";
    }

    return fs.readFileSync(DEV_LOG, "utf8").trim();
  } catch {
    return "";
  }
}

function explainStartFailure() {
  const log = readRecentLog();

  if (log.includes("listen EPERM")) {
    return [
      "本地虚拟人服务启动失败：当前环境不允许监听本地端口。",
      "这通常是沙箱或宿主权限限制，不是项目代码在抽风。",
      `请在有本地网络监听权限的终端里重试；日志位置：${DEV_LOG}`
    ].join("\n");
  }

  if (log.includes("EADDRINUSE")) {
    return [
      `本地虚拟人服务启动失败：端口 ${PORT} 已被占用。`,
      "请关闭占用进程，或改用其他端口。",
      `日志位置：${DEV_LOG}`
    ].join("\n");
  }

  return `本地虚拟人服务启动失败，请查看日志：${DEV_LOG}`;
}

function startDevServer() {
  fs.mkdirSync(path.dirname(DEV_LOG), { recursive: true });
  const logStream = fs.createWriteStream(DEV_LOG, { flags: "a" });
  const child = spawn("npm", ["run", "dev:avatar"], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.unref();
}

function openBrowser(url) {
  const platform = process.platform;

  if (platform === "darwin") {
    return spawn("open", [url], { stdio: "ignore" });
  }

  if (platform === "win32") {
    return spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" });
  }

  return spawn("xdg-open", [url], { stdio: "ignore" });
}

async function main() {
  const person = process.argv.slice(2).join(" ").trim();

  if (!person) {
    console.error("缺少人物名称。用法：npm run avatar:launch -- \"奶奶\"");
    process.exit(1);
  }

  let ready = await isServerReady();
  if (!ready) {
    startDevServer();
    ready = await waitForServer();
  }

  if (!ready) {
    console.error(explainStartFailure());
    process.exit(1);
  }

  const url = quotePerson(person);
  const browser = openBrowser(url);
  browser.on("error", (error) => {
    console.error(`页面已准备好，但浏览器没打开：${error.message}`);
    console.error(`请手动访问：${url}`);
    process.exit(1);
  });

  browser.unref();
  console.log(`已尝试打开 ${url}`);
}

void main();
