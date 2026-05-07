import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

export const HOST = "127.0.0.1";
export const AVATAR_PORT = 4173;
export const BRIDGE_PORT = 4174;
export const AVATAR_SERVER_URL = `http://${HOST}:${AVATAR_PORT}`;
export const BRIDGE_SERVER_URL = `http://${HOST}:${BRIDGE_PORT}`;
export const MEMORY_SERVER_URL = BRIDGE_SERVER_URL;
export const START_TIMEOUT_MS = 15000;
export const POLL_INTERVAL_MS = 500;
export const AVATAR_LOG = path.join(os.tmpdir(), "moss-user-dev.log");
export const BRIDGE_LOG = path.join(os.tmpdir(), "moss-memory-bridge.log");
export const STATE_FILE = path.join(os.tmpdir(), "moss-memory-bridge-state.json");
export const PROCESS_FILE = path.join(os.tmpdir(), "moss-memory-processes.json");
const REQUIRED_RPC_METHODS = [
  "persona/select",
  "thread/create",
  "thread/select",
  "thread/read",
  "turn/send",
  "context/push"
];

const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

function normalizeUrl(input) {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function asNonEmptyString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeContextEntry(entry, source = "codex-host") {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const text = asNonEmptyString(entry.text);
  if (!text) {
    return null;
  }

  return {
    id: asNonEmptyString(entry.id) ?? `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: asNonEmptyString(entry.source) ?? source,
    text,
    timestamp: asFiniteNumber(entry.timestamp, Date.now())
  };
}

function normalizeMessageRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const role = asNonEmptyString(record.role) ?? "system";
  const text = typeof record.text === "string" ? record.text : "";

  return {
    id: asNonEmptyString(record.id) ?? `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    pending: Boolean(record.pending),
    source: asNonEmptyString(record.source) ?? null,
    turnId: asNonEmptyString(record.turnId) ?? null,
    createdAt: asFiniteNumber(record.createdAt ?? record.timestamp, Date.now())
  };
}

function normalizeCompatEvent(record, threadId) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const type = asNonEmptyString(record.type);
  const sessionId = asNonEmptyString(record.sessionId) ?? asNonEmptyString(record.bridgeId);

  if (!type || !sessionId) {
    return null;
  }

  return {
    type,
    sessionId,
    bridgeId: sessionId,
    threadId: asNonEmptyString(record.threadId) ?? threadId ?? null,
    personId: asNonEmptyString(record.personId) ?? null,
    payload: record.payload ?? null,
    source: asNonEmptyString(record.source) ?? "bridge-server",
    timestamp: asFiniteNumber(record.timestamp, Date.now()),
    eventId: asFiniteNumber(record.eventId, 0)
  };
}

function normalizeThreadRecord(record, fallbackThreadId = null) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const threadId = asNonEmptyString(record.threadId) ?? fallbackThreadId;
  if (!threadId) {
    return null;
  }

  const messages = Array.isArray(record.messages)
    ? record.messages.map(normalizeMessageRecord).filter(Boolean)
    : [];
  const contextEntries = Array.isArray(record.contextEntries)
    ? record.contextEntries.map((entry) => normalizeContextEntry(entry, "codex-host")).filter(Boolean)
    : [];
  const compatEvents = Array.isArray(record.compatEvents)
    ? record.compatEvents.map((event) => normalizeCompatEvent(event, threadId)).filter(Boolean)
    : [];

  return {
    threadId,
    appThreadId: asNonEmptyString(record.appThreadId) ?? threadId,
    title: asNonEmptyString(record.title) ?? "新回合",
    preview: typeof record.preview === "string" ? record.preview : "",
    createdAt: asFiniteNumber(record.createdAt, Date.now()),
    updatedAt: asFiniteNumber(record.updatedAt, Date.now()),
    status: asNonEmptyString(record.status) ?? "idle",
    lastError: asNonEmptyString(record.lastError) ?? null,
    messages,
    contextEntries,
    compatEvents,
    lastReadEventId: asFiniteNumber(record.lastReadEventId, 0)
  };
}

function mergeThreads(previousThreads, nextThreads) {
  const merged = new Map();

  for (const thread of previousThreads ?? []) {
    merged.set(thread.threadId, thread);
  }

  for (const thread of nextThreads ?? []) {
    const previous = merged.get(thread.threadId);
    merged.set(
      thread.threadId,
      normalizeThreadRecord({
        ...previous,
        ...thread,
        messages: Array.isArray(thread.messages) ? thread.messages : previous?.messages,
        contextEntries: Array.isArray(thread.contextEntries) ? thread.contextEntries : previous?.contextEntries,
        compatEvents: Array.isArray(thread.compatEvents) ? thread.compatEvents : previous?.compatEvents
      }, thread.threadId)
    );
  }

  return Array.from(merged.values()).filter(Boolean);
}

function normalizeSessionRecord(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  const personId = asNonEmptyString(record.personId);
  const sessionId = asNonEmptyString(record.sessionId) ?? asNonEmptyString(record.bridgeId);

  if (!personId || !sessionId) {
    return null;
  }

  const rawThreads = Array.isArray(record.threads)
    ? record.threads.map((thread) => normalizeThreadRecord(thread)).filter(Boolean)
    : [];
  const currentThreadIdCandidate =
    asNonEmptyString(record.currentThreadId)
    ?? asNonEmptyString(record.threadId)
    ?? rawThreads[0]?.threadId
    ?? null;

  let threads = rawThreads;

  if (!threads.some((thread) => thread.threadId === currentThreadIdCandidate) && currentThreadIdCandidate) {
    threads = mergeThreads(threads, [
      {
        threadId: currentThreadIdCandidate,
        title: "新回合",
        preview: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: "idle",
        lastError: null,
        messages: [],
        contextEntries: [],
        compatEvents: [],
        lastReadEventId: asFiniteNumber(record.lastReadEventId, 0)
      }
    ]);
  }

  const currentThreadId = currentThreadIdCandidate ?? threads[0]?.threadId ?? null;
  const lastReadEventIdByThread = Object.fromEntries(
    Object.entries(record.lastReadEventIdByThread ?? {})
      .map(([threadId, value]) => [threadId, asFiniteNumber(value, 0)])
  );

  for (const thread of threads) {
    if (typeof lastReadEventIdByThread[thread.threadId] !== "number") {
      lastReadEventIdByThread[thread.threadId] = thread.lastReadEventId ?? 0;
    }
  }

  if (currentThreadId && typeof lastReadEventIdByThread[currentThreadId] !== "number") {
    lastReadEventIdByThread[currentThreadId] = asFiniteNumber(record.lastReadEventId, 0);
  }

  return {
    personId,
    sessionId,
    bridgeId: sessionId,
    avatarUrl: asNonEmptyString(record.avatarUrl) ?? null,
    bridgeServerUrl: asNonEmptyString(record.bridgeServerUrl) ?? null,
    createdAt: asFiniteNumber(record.createdAt, Date.now()),
    updatedAt: asFiniteNumber(record.updatedAt, Date.now()),
    currentThreadId,
    threadId: currentThreadId,
    threads,
    lastReadEventIdByThread,
    lastReadEventId: currentThreadId ? asFiniteNumber(lastReadEventIdByThread[currentThreadId], 0) : 0
  };
}

function emptyState() {
  return {
    current: null,
    byPerson: {}
  };
}

function readProcessRegistry() {
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

function writeProcessRegistry(registry) {
  fs.mkdirSync(path.dirname(PROCESS_FILE), { recursive: true });
  fs.writeFileSync(PROCESS_FILE, JSON.stringify(registry, null, 2));
}

function rememberProcess(name, pid, metadata = {}) {
  if (!pid) {
    return;
  }

  const registry = readProcessRegistry();
  registry[name] = {
    pid,
    updatedAt: Date.now(),
    ...metadata
  };
  writeProcessRegistry(registry);
}

function readLog(logFile) {
  try {
    if (!fs.existsSync(logFile)) {
      return "";
    }

    return fs.readFileSync(logFile, "utf8").trim();
  } catch {
    return "";
  }
}

function formatPermissionError(logFile, serviceName, port) {
  return [
    `${serviceName} 启动失败：当前环境不允许监听本地端口 ${port}。`,
    "这通常是宿主权限在摆架子，不是代码突然内向了。",
    `请在有本地网络监听权限的终端里重试；日志位置：${logFile}`
  ].join("\n");
}

function formatPortBusyError(logFile, serviceName, port) {
  return [
    `${serviceName} 启动失败：端口 ${port} 已被占用。`,
    "请关掉占坑进程，别让两个服务在门口抢拖鞋。",
    `日志位置：${logFile}`
  ].join("\n");
}

function formatIncompatibleBridgeError(logFile, serviceName, port) {
  return [
    `${serviceName} 检测到旧版桥服务仍占着端口 ${port}。`,
    "它会回 /health 和 /api/memory/launch，但不支持当前页面必需的 /codex-api 接口。",
    "请先结束旧桥服务，再重新唤起页面，别让老同事拿旧工牌混进新工位。",
    `日志位置：${logFile}`
  ].join("\n");
}

export function explainStartFailure(logFile, serviceName, port) {
  const log = readLog(logFile);

  if (log.includes("listen EPERM")) {
    return formatPermissionError(logFile, serviceName, port);
  }

  if (log.includes("EADDRINUSE")) {
    return formatPortBusyError(logFile, serviceName, port);
  }

  return `${serviceName} 启动失败，请查看日志：${logFile}`;
}

function hasRequiredRpcMethods(response) {
  const methods = Array.isArray(response?.json?.data) ? response.json.data : [];
  return REQUIRED_RPC_METHODS.every((method) => methods.includes(method));
}

export function request(urlString, options = {}) {
  const url = new URL(urlString);
  const method = options.method ?? "GET";
  const headers = options.headers ?? {};
  const body = options.body ? JSON.stringify(options.body) : null;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        timeout: options.timeout ?? 2000,
        headers: {
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body)
              }
            : {}),
          ...headers
        }
      },
      (res) => {
        const chunks = [];

        res.on("data", (chunk) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;

          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }

          resolve({
            statusCode: res.statusCode ?? 0,
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            text,
            json
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("request timeout"));
    });
    req.on("error", reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

export async function isHttpReady(urlString, validate) {
  try {
    const response = await request(urlString);
    if (!response.ok) {
      return false;
    }

    return typeof validate === "function" ? validate(response) : true;
  } catch {
    return false;
  }
}

export async function waitForHttp(urlString, validate, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await isHttpReady(urlString, validate)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return false;
}

export function startDetached(command, args, logFile, cwd = process.cwd()) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  child.unref();
  return child;
}

export async function ensureAvatarServer(cwd = process.cwd()) {
  const ready = await isHttpReady(AVATAR_SERVER_URL);
  if (ready) {
    return AVATAR_SERVER_URL;
  }

  const child = startDetached(NPM_BIN, ["run", "dev:user"], AVATAR_LOG, cwd);
  rememberProcess("avatar", child.pid, {
    port: AVATAR_PORT,
    command: `${NPM_BIN} run dev:user`,
    logFile: AVATAR_LOG
  });
  const started = await waitForHttp(AVATAR_SERVER_URL);

  if (!started) {
    throw new Error(explainStartFailure(AVATAR_LOG, "本地人物回忆页", AVATAR_PORT));
  }

  return AVATAR_SERVER_URL;
}

export async function isBridgeServerCompatible(serverUrl = BRIDGE_SERVER_URL) {
  try {
    const response = await request(`${serverUrl}/codex-api/meta/methods`);
    return response.ok && hasRequiredRpcMethods(response);
  } catch {
    return false;
  }
}

export async function ensureBridgeServer(cwd = process.cwd()) {
  const healthUrl = `${BRIDGE_SERVER_URL}/health`;
  const compatible = await isBridgeServerCompatible(BRIDGE_SERVER_URL);
  if (compatible) {
    return BRIDGE_SERVER_URL;
  }

  const legacyReady = await isHttpReady(
    healthUrl,
    (response) => response.json?.service === "moss-memory-app-server" || response.json?.legacyService === "moss-memory-bridge"
  );

  if (legacyReady) {
    throw new Error(formatIncompatibleBridgeError(BRIDGE_LOG, "本地记忆桥服务", BRIDGE_PORT));
  }

  const child = startDetached(process.execPath, ["scripts/memory-app-server.mjs"], BRIDGE_LOG, cwd);
  rememberProcess("bridge", child.pid, {
    port: BRIDGE_PORT,
    command: `${process.execPath} scripts/memory-app-server.mjs`,
    logFile: BRIDGE_LOG
  });
  const started = await waitForHttp(`${BRIDGE_SERVER_URL}/codex-api/meta/methods`, hasRequiredRpcMethods);

  if (!started) {
    const staleReady = await isHttpReady(
      healthUrl,
      (response) => response.json?.service === "moss-memory-app-server" || response.json?.legacyService === "moss-memory-bridge"
    );
    if (staleReady) {
      throw new Error(formatIncompatibleBridgeError(BRIDGE_LOG, "本地记忆桥服务", BRIDGE_PORT));
    }

    throw new Error(explainStartFailure(BRIDGE_LOG, "本地记忆桥服务", BRIDGE_PORT));
  }

  return BRIDGE_SERVER_URL;
}

export function openBrowser(url) {
  const platform = process.platform;

  if (platform === "darwin") {
    return spawn("open", [url], { stdio: "ignore" });
  }

  if (platform === "win32") {
    return spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" });
  }

  return spawn("xdg-open", [url], { stdio: "ignore" });
}

export function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return emptyState();
    }

    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const byPerson = Object.fromEntries(
      Object.entries(parsed.byPerson ?? {})
        .map(([personId, record]) => [personId, normalizeSessionRecord(record)])
        .filter(([, record]) => record)
    );

    const current = normalizeSessionRecord(parsed.current);

    return {
      current: current && byPerson[current.personId] ? byPerson[current.personId] : current,
      byPerson
    };
  } catch {
    return emptyState();
  }
}

export function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        current: normalizeSessionRecord(state.current),
        byPerson: Object.fromEntries(
          Object.entries(state.byPerson ?? {})
            .map(([personId, record]) => [personId, normalizeSessionRecord(record)])
            .filter(([, record]) => record)
        )
      },
      null,
      2
    )
  );
}

export function rememberSession(record) {
  const state = readState();
  const previous = state.byPerson[record.personId] ?? null;
  const nextRecord = normalizeSessionRecord({
    ...previous,
    ...record,
    currentThreadId: record.currentThreadId ?? record.threadId ?? previous?.currentThreadId ?? previous?.threadId,
    threads: Array.isArray(record.threads)
      ? mergeThreads(previous?.threads ?? [], record.threads)
      : previous?.threads ?? [],
    lastReadEventIdByThread: {
      ...(previous?.lastReadEventIdByThread ?? {}),
      ...(record.lastReadEventIdByThread ?? {})
    }
  });

  state.current = nextRecord;
  state.byPerson[nextRecord.personId] = nextRecord;
  writeState(state);
  return nextRecord;
}

export function findRememberedSession(identifier) {
  const state = readState();

  if (!identifier) {
    return state.current ?? null;
  }

  if (state.byPerson[identifier]) {
    return state.byPerson[identifier];
  }

  const records = Object.values(state.byPerson);
  return records.find((record) =>
    record.bridgeId === identifier
    || record.sessionId === identifier
    || record.currentThreadId === identifier
    || record.threads.some((thread) => thread.threadId === identifier)
  ) ?? null;
}

export function updateRememberedSession(identifier, patch) {
  const state = readState();
  const currentRecord = findRememberedSession(identifier);

  if (!currentRecord) {
    return null;
  }

  const nextRecord = normalizeSessionRecord({
    ...currentRecord,
    ...patch,
    currentThreadId: patch?.currentThreadId ?? patch?.threadId ?? currentRecord.currentThreadId,
    threads: Array.isArray(patch?.threads)
      ? mergeThreads(currentRecord.threads ?? [], patch.threads)
      : currentRecord.threads ?? [],
    lastReadEventIdByThread: {
      ...(currentRecord.lastReadEventIdByThread ?? {}),
      ...(patch?.lastReadEventIdByThread ?? {}),
      ...(patch?.threadId || patch?.currentThreadId
        ? {
            [patch.currentThreadId ?? patch.threadId]: asFiniteNumber(
              patch.lastReadEventId,
              currentRecord.lastReadEventIdByThread?.[patch.currentThreadId ?? patch.threadId] ?? 0
            )
          }
        : {})
    }
  });

  state.byPerson[nextRecord.personId] = nextRecord;

  if (
    state.current?.personId === currentRecord.personId ||
    state.current?.bridgeId === currentRecord.bridgeId
  ) {
    state.current = nextRecord;
  }

  writeState(state);
  return nextRecord;
}

export function createContextEntries(entries, source = "codex-host") {
  const list = Array.isArray(entries) ? entries : [entries];

  return list
    .filter((entry) => {
      if (typeof entry === "string") {
        return entry.trim().length > 0;
      }

      return Boolean(entry && typeof entry === "object" && String(entry.text ?? "").trim().length > 0);
    })
    .map((entry) => {
      if (typeof entry === "string") {
        return {
          id: `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          source,
          text: entry.trim(),
          timestamp: Date.now()
        };
      }

      return normalizeContextEntry(entry, source);
    })
    .filter(Boolean);
}

export function parseMaybeJson(input) {
  if (!input) {
    return null;
  }

  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

export function stripTrailingSlash(input) {
  return normalizeUrl(input);
}
