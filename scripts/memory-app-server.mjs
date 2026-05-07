import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { CodexAppClient } from "./codex-app-client.mjs";
import {
  AVATAR_SERVER_URL,
  BRIDGE_PORT,
  BRIDGE_SERVER_URL,
  HOST,
  createContextEntries,
  findRememberedSession,
  rememberSession,
  readState
} from "./memory-runtime.mjs";
import {
  buildPersonaDeveloperInstructions,
  getProjectRoot,
  loadPersonProfile
} from "./memory-profile.mjs";

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_EVENTS_PER_THREAD = 300;
const MAX_MESSAGES_PER_THREAD = 120;
const RPC_METHODS = [
  "persona/select",
  "workspace/read",
  "thread/list",
  "thread/create",
  "thread/select",
  "thread/read",
  "turn/send",
  "context/push"
];
const NOTIFICATION_TYPES = [
  "transport.ready",
  "thread.created",
  "thread.selected",
  "thread.updated",
  "thread.message.appended",
  "thread.message.delta",
  "thread.message.completed",
  "thread.state.changed",
  "context.updated"
];
const MEMORY_EVENT_TYPES = new Set([
  "session.started",
  "context.updated",
  "user.message",
  "persona.message",
  "status.changed",
  "sync.requested"
]);

const appClient = new CodexAppClient({
  cwd: getProjectRoot()
});
const workspaces = new Map();
const appThreadIndex = new Map();
const pendingTurns = new Map();

appClient.onNotification(({ method, params }) => {
  try {
    handleAppNotification(method, params);
  } catch {
    // 实时通知偶尔翻车时，不要把整个桥服务一起带走。
  }
});

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

function nowIso() {
  return new Date().toISOString();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function sendRpcResult(res, result) {
  sendJson(res, 200, { result });
}

function sendRpcError(res, statusCode, message) {
  sendJson(res, statusCode, {
    error: {
      message
    }
  });
}

function sendSseHeaders(res) {
  res.writeHead(200, {
    "access-control-allow-origin": "*",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8"
  });
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
}

function toPreview(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 88);
}

function defaultThreadTitle(workspace) {
  return `第 ${String(workspace.threads.size + 1).padStart(2, "0")} 段回声`;
}

function deriveThreadTitleFromText(text, fallback) {
  const preview = toPreview(text);
  if (!preview) {
    return fallback;
  }

  return preview.length > 18 ? `${preview.slice(0, 18)}…` : preview;
}

function createMessage(role, text, options = {}) {
  return {
    id: options.id ?? `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text: text ?? "",
    pending: Boolean(options.pending),
    source: options.source ?? null,
    turnId: options.turnId ?? null,
    createdAt: asFiniteNumber(options.createdAt, Date.now())
  };
}

function createThreadState(record = {}) {
  const compatEvents = Array.isArray(record.compatEvents)
    ? record.compatEvents.map((event) => ({
        ...event,
        eventId: asFiniteNumber(event.eventId, 0)
      }))
    : [];
  const messages = Array.isArray(record.messages)
    ? record.messages.map((message) => createMessage(message.role ?? "system", message.text ?? "", message))
    : [];

  return {
    threadId: asNonEmptyString(record.threadId) ?? randomUUID(),
    appThreadId: asNonEmptyString(record.appThreadId) ?? asNonEmptyString(record.threadId) ?? null,
    title: asNonEmptyString(record.title) ?? "新回合",
    preview: typeof record.preview === "string" ? record.preview : "",
    createdAt: asFiniteNumber(record.createdAt, Date.now()),
    updatedAt: asFiniteNumber(record.updatedAt, Date.now()),
    status: record.status === "error" ? "error" : "idle",
    lastError: asNonEmptyString(record.lastError) ?? null,
    messages,
    contextEntries: Array.isArray(record.contextEntries) ? record.contextEntries : [],
    compatEvents,
    nextEventId: compatEvents.reduce((max, event) => Math.max(max, asFiniteNumber(event.eventId, 0)), 0) + 1,
    appGeneration: null,
    appReady: false,
    pendingAssistantMessageId: null
  };
}

function createWorkspaceState(record = {}) {
  const sessionId = asNonEmptyString(record.sessionId) ?? asNonEmptyString(record.bridgeId) ?? randomUUID();
  const workspace = {
    sessionId,
    bridgeId: sessionId,
    personId: asNonEmptyString(record.personId),
    createdAt: asFiniteNumber(record.createdAt, Date.now()),
    updatedAt: asFiniteNumber(record.updatedAt, Date.now()),
    currentThreadId: asNonEmptyString(record.currentThreadId) ?? asNonEmptyString(record.threadId) ?? null,
    threads: new Map(),
    notificationStreams: new Set(),
    memoryStreams: new Set(),
    sockets: new Set()
  };

  const threadRecords = Array.isArray(record.threads) ? record.threads : [];
  for (const threadRecord of threadRecords) {
    const thread = createThreadState(threadRecord);
    workspace.threads.set(thread.threadId, thread);
    registerAppThread(workspace.sessionId, thread);
  }

  if (!workspace.currentThreadId && workspace.threads.size > 0) {
    workspace.currentThreadId = Array.from(workspace.threads.keys())[0];
  }

  return workspace;
}

function workspaceToStoredRecord(workspace) {
  const threads = Array.from(workspace.threads.values()).map((thread) => ({
    threadId: thread.threadId,
    appThreadId: thread.appThreadId,
    title: thread.title,
    preview: thread.preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: thread.status,
    lastError: thread.lastError,
    messages: thread.messages.slice(-MAX_MESSAGES_PER_THREAD),
    contextEntries: thread.contextEntries,
    compatEvents: thread.compatEvents.slice(-MAX_EVENTS_PER_THREAD),
    lastReadEventId: thread.compatEvents.at(-1)?.eventId ?? 0
  }));

  return {
    personId: workspace.personId,
    sessionId: workspace.sessionId,
    bridgeId: workspace.sessionId,
    avatarUrl: buildAvatarUrl(workspace.personId, workspace.sessionId, workspace.currentThreadId),
    bridgeServerUrl: BRIDGE_SERVER_URL,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    currentThreadId: workspace.currentThreadId,
    threadId: workspace.currentThreadId,
    threads,
    lastReadEventIdByThread: Object.fromEntries(
      threads.map((thread) => [thread.threadId, thread.lastReadEventId])
    ),
    lastReadEventId: workspace.currentThreadId
      ? threads.find((thread) => thread.threadId === workspace.currentThreadId)?.lastReadEventId ?? 0
      : 0
  };
}

function summarizeThread(thread) {
  const lastMessage = [...thread.messages].reverse().find((message) => toPreview(message.text));

  return {
    threadId: thread.threadId,
    title: thread.title,
    preview: toPreview(lastMessage?.text ?? thread.preview),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: thread.status,
    lastError: thread.lastError,
    messageCount: thread.messages.length,
    contextCount: thread.contextEntries.length
  };
}

function registerAppThread(workspaceId, thread) {
  const appThreadId = asNonEmptyString(thread?.appThreadId);
  const threadId = asNonEmptyString(thread?.threadId);

  if (!workspaceId || !appThreadId || !threadId) {
    return;
  }

  appThreadIndex.set(appThreadId, {
    workspaceId,
    threadId
  });
}

function unregisterAppThread(appThreadId) {
  if (!appThreadId) {
    return;
  }

  appThreadIndex.delete(appThreadId);
}

function serializeMessage(message) {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    pending: Boolean(message.pending),
    source: message.source,
    turnId: message.turnId,
    createdAt: message.createdAt
  };
}

function serializeThread(thread) {
  return {
    ...summarizeThread(thread),
    messages: thread.messages.map(serializeMessage),
    contextEntries: thread.contextEntries
  };
}

function serializeWorkspace(workspace) {
  return {
    sessionId: workspace.sessionId,
    bridgeId: workspace.sessionId,
    personId: workspace.personId,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    currentThreadId: workspace.currentThreadId,
    threadId: workspace.currentThreadId,
    threads: Array.from(workspace.threads.values())
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(summarizeThread),
    threadCount: workspace.threads.size
  };
}

function buildAvatarUrl(personId, sessionId, threadId) {
  const url = new URL("/", AVATAR_SERVER_URL);
  url.searchParams.set("person", personId);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("bridge", sessionId);
  url.searchParams.set("server", BRIDGE_SERVER_URL);
  url.searchParams.set("bridgeServer", BRIDGE_SERVER_URL);
  if (threadId) {
    url.searchParams.set("thread", threadId);
  }
  return url.toString();
}

function touchWorkspace(workspace) {
  workspace.updatedAt = Date.now();
}

function persistWorkspace(workspace) {
  rememberSession(workspaceToStoredRecord(workspace));
}

function appendCompatEvent(workspace, thread, type, payload, source = "bridge-server") {
  const record = {
    type,
    sessionId: workspace.sessionId,
    bridgeId: workspace.sessionId,
    threadId: thread.threadId,
    personId: workspace.personId,
    payload,
    source,
    timestamp: Date.now(),
    eventId: thread.nextEventId
  };

  thread.nextEventId += 1;
  thread.compatEvents.push(record);
  if (thread.compatEvents.length > MAX_EVENTS_PER_THREAD) {
    thread.compatEvents.splice(0, thread.compatEvents.length - MAX_EVENTS_PER_THREAD);
  }

  for (const stream of workspace.memoryStreams) {
    if (stream.threadId && stream.threadId !== thread.threadId) {
      continue;
    }

    const payloadToSend = stream.format === "legacy"
      ? compatEventToLegacyEnvelope(record)
      : simplifyCompatEvent(record);
    stream.res.write(`data: ${JSON.stringify(payloadToSend)}\n\n`);
  }

  return record;
}

function appendMessage(workspace, thread, message, options = {}) {
  thread.messages.push(message);
  if (thread.messages.length > MAX_MESSAGES_PER_THREAD) {
    thread.messages.splice(0, thread.messages.length - MAX_MESSAGES_PER_THREAD);
  }

  thread.updatedAt = Date.now();
  thread.preview = toPreview(message.text || thread.preview);
  touchWorkspace(workspace);

  if (options.broadcast !== false) {
    publishNotification(workspace, {
      type: "thread.message.appended",
      threadId: thread.threadId,
      payload: {
        message: serializeMessage(message)
      }
    });
    publishNotification(workspace, {
      type: "thread.updated",
      threadId: thread.threadId,
      payload: {
        thread: summarizeThread(thread)
      }
    });
  }
}

function setThreadStatus(workspace, thread, status, detail = null) {
  thread.status = status;
  thread.lastError = detail;
  thread.updatedAt = Date.now();
  touchWorkspace(workspace);

  appendCompatEvent(
    workspace,
    thread,
    "status.changed",
    {
      state: status,
      detail: detail ?? undefined
    },
    status === "running" ? "codex-host" : "codex-app"
  );

  publishNotification(workspace, {
    type: "thread.state.changed",
    threadId: thread.threadId,
    payload: {
      state: status,
      detail
    }
  });
  publishNotification(workspace, {
    type: "thread.updated",
    threadId: thread.threadId,
    payload: {
      thread: summarizeThread(thread)
    }
  });
}

function publishNotification(workspace, event) {
  const payload = {
    ...event,
    sessionId: workspace.sessionId,
    personId: workspace.personId,
    atIso: nowIso()
  };

  for (const stream of workspace.notificationStreams) {
    stream.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  const serialized = JSON.stringify(payload);
  for (const socket of workspace.sockets) {
    try {
      writeWebSocketText(socket, serialized);
    } catch {
      socket.destroy();
    }
  }
}

function compatEventToLegacyEnvelope(event) {
  switch (event.type) {
    case "session.started":
      return {
        type: "bridge:ready",
        bridgeId: event.sessionId,
        sessionId: event.sessionId,
        threadId: event.threadId,
        source: event.source,
        timestamp: event.timestamp,
        eventId: event.eventId,
        payload: {
          personId: event.personId,
          bridgeId: event.sessionId
        }
      };
    case "context.updated":
      return {
        type: "bridge:context-update",
        bridgeId: event.sessionId,
        sessionId: event.sessionId,
        threadId: event.threadId,
        source: event.source,
        timestamp: event.timestamp,
        eventId: event.eventId,
        payload: event.payload
      };
    case "user.message":
      return {
        type: "bridge:user-message",
        bridgeId: event.sessionId,
        sessionId: event.sessionId,
        threadId: event.threadId,
        source: event.source,
        timestamp: event.timestamp,
        eventId: event.eventId,
        payload: {
          text: event.payload?.text ?? "",
          personId: event.personId
        }
      };
    case "persona.message":
      return {
        type: "bridge:persona-message",
        bridgeId: event.sessionId,
        sessionId: event.sessionId,
        threadId: event.threadId,
        source: event.source,
        timestamp: event.timestamp,
        eventId: event.eventId,
        payload: {
          text: event.payload?.text ?? "",
          personId: event.personId
        }
      };
    case "status.changed":
      return {
        type: "bridge:status",
        bridgeId: event.sessionId,
        sessionId: event.sessionId,
        threadId: event.threadId,
        source: event.source,
        timestamp: event.timestamp,
        eventId: event.eventId,
        payload: event.payload
      };
    case "sync.requested":
    default:
      return {
        type: "bridge:request-context",
        bridgeId: event.sessionId,
        sessionId: event.sessionId,
        threadId: event.threadId,
        source: event.source,
        timestamp: event.timestamp,
        eventId: event.eventId,
        payload: {
          reason: event.payload?.reason ?? "memory-sync"
        }
      };
  }
}

function simplifyCompatEvent(event) {
  return {
    eventId: event.eventId,
    type: event.type,
    source: event.source,
    timestamp: event.timestamp,
    threadId: event.threadId,
    summary: summarizeCompatEvent(event),
    payload: event.payload
  };
}

function summarizeCompatEvent(event) {
  switch (event.type) {
    case "session.started":
      return "网页控制台已接入会话。";
    case "context.updated":
      return `共享上下文已更新 ${Array.isArray(event.payload?.entries) ? event.payload.entries.length : 0} 条。`;
    case "user.message":
      return `网页用户输入：${event.payload?.text ?? ""}`;
    case "persona.message":
      return `虚拟人回复：${event.payload?.text ?? ""}`;
    case "status.changed":
      return `线程状态：${event.payload?.state ?? "unknown"}${event.payload?.detail ? ` (${event.payload.detail})` : ""}`;
    case "sync.requested":
      return `触发同步：${event.payload?.reason ?? "未说明原因"}`;
    default:
      return `会话事件：${event.type}`;
  }
}

function findWorkspace(identifier) {
  if (!identifier) {
    return null;
  }

  if (workspaces.has(identifier)) {
    return workspaces.get(identifier);
  }

  for (const workspace of workspaces.values()) {
    if (workspace.personId === identifier || workspace.currentThreadId === identifier) {
      return workspace;
    }

    if (workspace.threads.has(identifier)) {
      return workspace;
    }
  }

  return null;
}

function getCurrentThread(workspace, preferredThreadId = null) {
  const threadId = preferredThreadId ?? workspace.currentThreadId;
  return threadId ? workspace.threads.get(threadId) ?? null : null;
}

function ensureWorkspace(personId, sessionId = null) {
  const normalizedSessionId = asNonEmptyString(sessionId);
  const remembered = findRememberedSession(personId) ?? (normalizedSessionId ? findRememberedSession(normalizedSessionId) : null);
  const wantedId = normalizedSessionId ?? remembered?.sessionId ?? remembered?.bridgeId ?? randomUUID();
  const existing = findWorkspace(wantedId) ?? findWorkspace(personId);

  if (existing) {
    if (personId && existing.personId !== personId) {
      throw new Error(`session ${wantedId} 已绑定人物 ${existing.personId}，别让回忆串台。`);
    }

    touchWorkspace(existing);
    return {
      workspace: existing,
      reused: true
    };
  }

  const seed = remembered?.personId === personId
    ? remembered
    : {
        personId,
        sessionId: wantedId,
        bridgeId: wantedId,
        threads: []
      };

  const workspace = createWorkspaceState({
    ...seed,
    personId,
    sessionId: wantedId,
    bridgeId: wantedId
  });

  workspaces.set(workspace.sessionId, workspace);
  touchWorkspace(workspace);
  persistWorkspace(workspace);
  return {
    workspace,
    reused: false
  };
}

async function ensureCodexThread(workspace, thread) {
  const profile = loadPersonProfile(workspace.personId);
  const developerInstructions = buildPersonaDeveloperInstructions(profile);

  if (
    thread.appThreadId &&
    thread.appReady &&
    thread.appGeneration === appClient.generation
  ) {
    return thread.appThreadId;
  }

  if (thread.appThreadId) {
    try {
      const resumed = await appClient.resumeThread({
        threadId: thread.appThreadId,
        cwd: getProjectRoot(),
        developerInstructions
      });
      unregisterAppThread(thread.appThreadId);
      thread.appThreadId = resumed.thread.id;
      thread.appGeneration = appClient.generation;
      thread.appReady = true;
      thread.lastError = null;
      registerAppThread(workspace.sessionId, thread);
      return thread.appThreadId;
    } catch (error) {
      thread.appReady = false;
      thread.lastError = error instanceof Error ? error.message : String(error);
      unregisterAppThread(thread.appThreadId);
      thread.appThreadId = null;
    }
  }

  const started = await appClient.startThread({
    cwd: getProjectRoot(),
    developerInstructions
  });

  thread.appThreadId = started.thread.id;
  thread.appGeneration = appClient.generation;
  thread.appReady = true;
  thread.lastError = null;
  registerAppThread(workspace.sessionId, thread);
  return thread.appThreadId;
}

async function createThread(workspace, options = {}) {
  const thread = createThreadState({
    title: asNonEmptyString(options.title) ?? defaultThreadTitle(workspace)
  });

  await ensureCodexThread(workspace, thread);
  workspace.threads.set(thread.threadId, thread);
  workspace.currentThreadId = thread.threadId;
  thread.updatedAt = Date.now();
  touchWorkspace(workspace);

  appendCompatEvent(
    workspace,
    thread,
    "session.started",
    {
      reason: options.reason ?? "thread-created"
    },
    "bridge-server"
  );

  persistWorkspace(workspace);
  publishNotification(workspace, {
    type: "thread.created",
    threadId: thread.threadId,
    payload: {
      thread: summarizeThread(thread),
      workspace: serializeWorkspace(workspace)
    }
  });
  publishNotification(workspace, {
    type: "thread.selected",
    threadId: thread.threadId,
    payload: {
      workspace: serializeWorkspace(workspace)
    }
  });

  return thread;
}

async function selectThread(workspace, threadId) {
  const thread = workspace.threads.get(threadId);
  if (!thread) {
    throw new Error(`未找到 threadId=${threadId}`);
  }

  await ensureCodexThread(workspace, thread);
  workspace.currentThreadId = thread.threadId;
  touchWorkspace(workspace);
  persistWorkspace(workspace);
  publishNotification(workspace, {
    type: "thread.selected",
    threadId: thread.threadId,
    payload: {
      workspace: serializeWorkspace(workspace)
    }
  });
  return thread;
}

function buildTurnInput(thread, text) {
  const contextLines = thread.contextEntries
    .slice(-4)
    .map((entry) => `- [${entry.source}] ${entry.text}`);

  if (contextLines.length === 0) {
    return text;
  }

  return [
    text,
    "",
    "补充上下文（只作参考，不要机械复述，也不要解释协议）：",
    ...contextLines
  ].join("\n");
}

function buildSyncPrompt(workspace, thread, prompt, unreadEvents) {
  const eventLines = unreadEvents.map((event) => `- ${summarizeCompatEvent(event)}`);
  const contextLines = thread.contextEntries
    .slice(-4)
    .map((entry) => `- [${entry.source}] ${entry.text}`);
  const blocks = [
    `当前人物：${workspace.personId}`,
    "你正在继续这位人物与用户的陪伴式对话。",
    "网页事件只是对话上下文，不要解释协议，也不要机械复述系统词。"
  ];

  if (eventLines.length > 0) {
    blocks.push(`网页自上次同步后的新事件：\n${eventLines.join("\n")}`);
  }

  if (contextLines.length > 0) {
    blocks.push(`共享上下文摘要：\n${contextLines.join("\n")}`);
  }

  if (prompt) {
    blocks.push(`当前宿主最新输入：\n${prompt}`);
  }

  blocks.push("请直接输出要发给宿主的一段中文正文，不要加额外包装。");
  return blocks.join("\n\n");
}

function cleanupExpiredWorkspaces() {
  const now = Date.now();

  for (const [workspaceId, workspace] of workspaces.entries()) {
    if (workspace.notificationStreams.size > 0 || workspace.memoryStreams.size > 0 || workspace.sockets.size > 0) {
      continue;
    }

    if (now - workspace.updatedAt <= SESSION_TTL_MS) {
      continue;
    }

    for (const thread of workspace.threads.values()) {
      unregisterAppThread(thread.appThreadId);
    }
    workspaces.delete(workspaceId);
  }
}

function initializeWorkspacesFromState() {
  const state = readState();
  for (const record of Object.values(state.byPerson ?? {})) {
    if (!record?.personId) {
      continue;
    }

    const workspace = createWorkspaceState(record);
    workspaces.set(workspace.sessionId, workspace);
  }
}

function startPendingTurn(workspace, thread, input, options = {}) {
  if (pendingTurns.has(thread.threadId)) {
    throw new Error(`thread ${thread.threadId} 已经有进行中的 turn，先别让两段回忆抢同一张嘴。`);
  }

  const assistantMessage = createMessage("assistant", "", {
    pending: true,
    source: options.source ?? "codex-app"
  });
  thread.pendingAssistantMessageId = assistantMessage.id;
  appendMessage(workspace, thread, assistantMessage);

  const pending = {
    workspaceId: workspace.sessionId,
    threadId: thread.threadId,
    assistantMessageId: assistantMessage.id,
    completed: false
  };

  pendingTurns.set(thread.threadId, pending);
  setThreadStatus(workspace, thread, "running", options.detail ?? "本地 Codex 正在接话。");
  persistWorkspace(workspace);

  appClient.runTurn({
    threadId: thread.appThreadId,
    text: input
  }).then((result) => {
    const current = pendingTurns.get(thread.threadId);
    if (!current) {
      return;
    }

    const latestThread = getCurrentThread(workspace, thread.threadId) ?? thread;
    const assistant = latestThread.messages.find((message) => message.id === current.assistantMessageId);

    if (assistant && !current.completed) {
      assistant.text = result.text ?? assistant.text;
      assistant.pending = false;
      assistant.turnId = result.turnId ?? null;
      latestThread.preview = toPreview(assistant.text);
      appendCompatEvent(
        workspace,
        latestThread,
        "persona.message",
        {
          text: assistant.text
        },
        "codex-app"
      );
      publishNotification(workspace, {
        type: "thread.message.completed",
        threadId: latestThread.threadId,
        payload: {
          message: serializeMessage(assistant),
          turnId: result.turnId ?? null
        }
      });
    }

    latestThread.pendingAssistantMessageId = null;
    pendingTurns.delete(thread.threadId);
    setThreadStatus(workspace, latestThread, "idle", "本地 Codex 已经把这句说完了。");
    persistWorkspace(workspace);
  }).catch((error) => {
    const current = pendingTurns.get(thread.threadId);
    if (!current) {
      return;
    }

    const latestThread = getCurrentThread(workspace, thread.threadId) ?? thread;
    const assistantIndex = latestThread.messages.findIndex((message) => message.id === current.assistantMessageId);
    if (assistantIndex >= 0 && !toPreview(latestThread.messages[assistantIndex].text)) {
      latestThread.messages.splice(assistantIndex, 1);
    } else if (assistantIndex >= 0) {
      latestThread.messages[assistantIndex].pending = false;
    }

    const message = error instanceof Error ? error.message : String(error);
    appendMessage(
      workspace,
      latestThread,
      createMessage("system", message, {
        source: "codex-app"
      })
    );
    latestThread.pendingAssistantMessageId = null;
    pendingTurns.delete(thread.threadId);
    setThreadStatus(workspace, latestThread, "error", message);
    persistWorkspace(workspace);
  });
}

async function sendUserTurn(workspace, thread, text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    throw new Error("消息不能为空。");
  }

  await ensureCodexThread(workspace, thread);

  const userMessage = createMessage("user", trimmed, {
    source: "avatar-page"
  });
  appendMessage(workspace, thread, userMessage);
  appendCompatEvent(
    workspace,
    thread,
    "user.message",
    {
      text: trimmed
    },
    "avatar-page"
  );

  if (
    thread.messages.filter((message) => message.role === "user").length === 1 &&
    /^第 \d{2} 段回声$/u.test(thread.title)
  ) {
    thread.title = deriveThreadTitleFromText(trimmed, thread.title);
  }

  persistWorkspace(workspace);
  startPendingTurn(workspace, thread, buildTurnInput(thread, trimmed), {
    source: "codex-app",
    detail: "本地 Codex 正在用这个人的口吻接话。"
  });

  return {
    accepted: true,
    threadId: thread.threadId
  };
}

function handleAppNotification(method, params) {
  const appThreadId = asNonEmptyString(params?.threadId);
  if (!appThreadId) {
    return;
  }

  const indexed = appThreadIndex.get(appThreadId);
  if (!indexed) {
    return;
  }

  const workspace = workspaces.get(indexed.workspaceId);
  const thread = workspace?.threads.get(indexed.threadId);
  const pending = pendingTurns.get(indexed.threadId);

  if (!workspace || !thread || !pending) {
    return;
  }

  if (method === "item/agentMessage/delta") {
    const assistant = thread.messages.find((message) => message.id === pending.assistantMessageId);
    if (!assistant) {
      return;
    }

    const delta = String(params?.delta ?? "");
    assistant.text += delta;
    assistant.pending = true;
    thread.preview = toPreview(assistant.text);
    thread.updatedAt = Date.now();
    touchWorkspace(workspace);
    publishNotification(workspace, {
      type: "thread.message.delta",
      threadId: thread.threadId,
      payload: {
        messageId: assistant.id,
        delta,
        text: assistant.text
      }
    });
    publishNotification(workspace, {
      type: "thread.updated",
      threadId: thread.threadId,
      payload: {
        thread: summarizeThread(thread)
      }
    });
    return;
  }

  if (method === "item/completed" && params?.item?.type === "agentMessage") {
    const assistant = thread.messages.find((message) => message.id === pending.assistantMessageId);
    if (!assistant) {
      return;
    }

    const completedText = String(params.item.text ?? "").trim();
    assistant.text = completedText || assistant.text;
    assistant.pending = false;
    thread.preview = toPreview(assistant.text);
    pending.completed = true;
    appendCompatEvent(
      workspace,
      thread,
      "persona.message",
      {
        text: assistant.text
      },
      "codex-app"
    );
    publishNotification(workspace, {
      type: "thread.message.completed",
      threadId: thread.threadId,
      payload: {
        message: serializeMessage(assistant),
        turnId: params?.turnId ?? null
      }
    });
    publishNotification(workspace, {
      type: "thread.updated",
      threadId: thread.threadId,
      payload: {
        thread: summarizeThread(thread)
      }
    });
    persistWorkspace(workspace);
  }
}

function listCompatEvents(thread, after, excludeSource) {
  return thread.compatEvents.filter((event) => {
    if (event.eventId <= after) {
      return false;
    }

    if (excludeSource && event.source === excludeSource) {
      return false;
    }

    return true;
  });
}

async function ensureWorkspaceAndThread(payload = {}) {
  const personId = asNonEmptyString(payload.personId)
    ?? findWorkspace(asNonEmptyString(payload.sessionId) ?? asNonEmptyString(payload.bridgeId))?.personId;

  if (!personId) {
    throw new Error("缺少 personId。");
  }

  const ensured = ensureWorkspace(personId, asNonEmptyString(payload.sessionId) ?? asNonEmptyString(payload.bridgeId));
  const workspace = ensured.workspace;
  let thread = getCurrentThread(workspace, asNonEmptyString(payload.threadId));

  if (!thread) {
    thread = await createThread(workspace, {
      reason: "workspace-boot"
    });
  } else if (payload.threadId) {
    thread = await selectThread(workspace, payload.threadId);
  }

  return {
    workspace,
    thread,
    reused: ensured.reused
  };
}

async function handleLaunch(req, res) {
  const body = await readBody(req);
  const result = await ensureWorkspaceAndThread(body);
  const entries = createContextEntries(body.context ?? [], "codex-host");

  if (entries.length > 0) {
    result.thread.contextEntries = body.replaceContext ? entries : [...result.thread.contextEntries, ...entries];
    appendCompatEvent(
      result.workspace,
      result.thread,
      "context.updated",
      {
        entries,
        replace: Boolean(body.replaceContext)
      },
      "codex-host"
    );
    publishNotification(result.workspace, {
      type: "context.updated",
      threadId: result.thread.threadId,
      payload: {
        entries,
        replace: Boolean(body.replaceContext)
      }
    });
  }

  await ensureCodexThread(result.workspace, result.thread);
  persistWorkspace(result.workspace);

  sendJson(res, 200, {
    ok: true,
    reused: result.reused,
    sessionId: result.workspace.sessionId,
    bridgeId: result.workspace.sessionId,
    personId: result.workspace.personId,
    threadId: result.thread.threadId,
    currentThreadId: result.thread.threadId,
    streamCount: result.workspace.notificationStreams.size + result.workspace.memoryStreams.size + result.workspace.sockets.size,
    contextCount: result.thread.contextEntries.length,
    bridgeServerUrl: BRIDGE_SERVER_URL,
    serverUrl: BRIDGE_SERVER_URL,
    avatarUrl: buildAvatarUrl(result.workspace.personId, result.workspace.sessionId, result.thread.threadId),
    workspace: serializeWorkspace(result.workspace),
    thread: serializeThread(result.thread)
  });
}

async function handleContext(req, res) {
  const body = await readBody(req);
  const workspace = findWorkspace(asNonEmptyString(body.sessionId) ?? asNonEmptyString(body.bridgeId));

  if (!workspace) {
    sendJson(res, 404, { ok: false, error: "未找到会话" });
    return;
  }

  const thread = getCurrentThread(workspace, asNonEmptyString(body.threadId));
  if (!thread) {
    sendJson(res, 404, { ok: false, error: "未找到线程" });
    return;
  }

  const entries = createContextEntries(body.entries ?? [], "codex-host");
  thread.contextEntries = body.replace ? entries : [...thread.contextEntries, ...entries];
  const record = appendCompatEvent(
    workspace,
    thread,
    "context.updated",
    {
      entries,
      replace: Boolean(body.replace)
    },
    "codex-host"
  );
  publishNotification(workspace, {
    type: "context.updated",
    threadId: thread.threadId,
    payload: {
      entries,
      replace: Boolean(body.replace)
    }
  });
  persistWorkspace(workspace);

  sendJson(res, 200, {
    ok: true,
    sessionId: workspace.sessionId,
    bridgeId: workspace.sessionId,
    threadId: thread.threadId,
    eventId: record.eventId,
    contextCount: thread.contextEntries.length
  });
}

async function handleSync(req, res) {
  const body = await readBody(req);
  const workspace = findWorkspace(asNonEmptyString(body.sessionId) ?? asNonEmptyString(body.bridgeId));

  if (!workspace) {
    sendJson(res, 404, { ok: false, error: "未找到会话" });
    return;
  }

  const thread = getCurrentThread(workspace, asNonEmptyString(body.threadId));
  if (!thread) {
    sendJson(res, 404, { ok: false, error: "未找到线程" });
    return;
  }

  const after = asFiniteNumber(body.after, 0);
  const includeHostEvents = Boolean(body.includeHostEvents);
  const payload = String(body.prompt ?? body.payload ?? "").trim();
  const unreadEvents = listCompatEvents(thread, after, includeHostEvents ? "" : "codex-host")
    .filter((event) => includeHostEvents || event.source !== "bridge-server");

  const syncRecord = appendCompatEvent(
    workspace,
    thread,
    "sync.requested",
    {
      reason: "codex-host-sync",
      unreadCount: unreadEvents.length
    },
    "codex-host"
  );

  if (payload) {
    const entries = createContextEntries([payload], "codex-host");
    thread.contextEntries = body.replace ? entries : [...thread.contextEntries, ...entries];
    appendCompatEvent(
      workspace,
      thread,
      "context.updated",
      {
        entries,
        replace: Boolean(body.replace)
      },
      "codex-host"
    );
    publishNotification(workspace, {
      type: "context.updated",
      threadId: thread.threadId,
      payload: {
        entries,
        replace: Boolean(body.replace)
      }
    });
  }

  let appReply = null;
  let appError = null;
  let turnId = null;

  try {
    await ensureCodexThread(workspace, thread);
    const assistantMessage = createMessage("assistant", "", {
      pending: true,
      source: "codex-app"
    });
    appendMessage(workspace, thread, assistantMessage);

    pendingTurns.set(thread.threadId, {
      workspaceId: workspace.sessionId,
      threadId: thread.threadId,
      assistantMessageId: assistantMessage.id,
      completed: false
    });
    setThreadStatus(workspace, thread, "running", "宿主同步触发了一轮本地 Codex。");

    const result = await appClient.runTurn({
      threadId: thread.appThreadId,
      text: buildSyncPrompt(workspace, thread, payload, unreadEvents)
    });
    const pending = pendingTurns.get(thread.threadId);

    turnId = result.turnId ?? null;
    const assistant = thread.messages.find((message) => message.id === assistantMessage.id);
    appReply = result.text ?? "";

    if (assistant && !pending?.completed) {
      assistant.text = appReply;
      assistant.pending = false;
      assistant.turnId = turnId;
      appendCompatEvent(
        workspace,
        thread,
        "persona.message",
        {
          text: appReply
        },
        "codex-app"
      );
      publishNotification(workspace, {
        type: "thread.message.completed",
        threadId: thread.threadId,
        payload: {
          message: serializeMessage(assistant ?? createMessage("assistant", appReply)),
          turnId
        }
      });
    } else if (assistant) {
      assistant.turnId = turnId;
    }
    setThreadStatus(workspace, thread, "idle", "宿主同步这一轮已经收尾。");
  } catch (error) {
    appError = error instanceof Error ? error.message : String(error);
    const assistantIndex = thread.messages.findIndex((message) => message.id === assistantMessage.id);
    if (assistantIndex >= 0 && !toPreview(thread.messages[assistantIndex].text)) {
      thread.messages.splice(assistantIndex, 1);
    } else if (assistantIndex >= 0) {
      thread.messages[assistantIndex].pending = false;
    }
    setThreadStatus(workspace, thread, "error", appError);
  } finally {
    pendingTurns.delete(thread.threadId);
    thread.pendingAssistantMessageId = null;
    persistWorkspace(workspace);
  }

  sendJson(res, appError ? 502 : 200, {
    ok: !appError,
    sessionId: workspace.sessionId,
    bridgeId: workspace.sessionId,
    personId: workspace.personId,
    threadId: thread.threadId,
    unreadCount: unreadEvents.length,
    unreadEvents: unreadEvents.map(simplifyCompatEvent),
    promptContext: unreadEvents.map(summarizeCompatEvent),
    previousCursor: after,
    nextCursor: Math.max(syncRecord.eventId, thread.compatEvents.at(-1)?.eventId ?? 0),
    appReply,
    turnId,
    appError,
    contextCount: thread.contextEntries.length,
    pushed: Boolean(payload),
    pushedCount: payload ? 1 : 0,
    contextEventId: thread.compatEvents.at(-1)?.eventId ?? 0
  });
}

async function handleMemoryEvent(req, res) {
  const body = await readBody(req);
  const workspace = findWorkspace(asNonEmptyString(body.sessionId) ?? asNonEmptyString(body.bridgeId));

  if (!workspace) {
    sendJson(res, 404, { ok: false, error: "未找到会话" });
    return;
  }

  const thread = getCurrentThread(workspace, asNonEmptyString(body.threadId));
  if (!thread) {
    sendJson(res, 404, { ok: false, error: "未找到线程" });
    return;
  }

  if (body.type === "bridge:request-context" || body.type === "sync.requested") {
    const record = appendCompatEvent(
      workspace,
      thread,
      "sync.requested",
      {
        reason: body.payload?.reason ?? body.reason ?? "avatar-request-context"
      },
      body.source ?? "avatar-page"
    );
    sendJson(res, 200, {
      ok: true,
      sessionId: workspace.sessionId,
      threadId: thread.threadId,
      eventId: record.eventId
    });
    return;
  }

  if (body.type === "bridge:context-update" || body.type === "context.updated") {
    const entries = createContextEntries(body.payload?.entries ?? body.entries ?? [], body.source ?? "avatar-page");
    thread.contextEntries = body.payload?.replace || body.replace
      ? entries
      : [...thread.contextEntries, ...entries];
    const record = appendCompatEvent(
      workspace,
      thread,
      "context.updated",
      {
        entries,
        replace: Boolean(body.payload?.replace ?? body.replace)
      },
      body.source ?? "avatar-page"
    );
    publishNotification(workspace, {
      type: "context.updated",
      threadId: thread.threadId,
      payload: {
        entries,
        replace: Boolean(body.payload?.replace ?? body.replace)
      }
    });
    persistWorkspace(workspace);
    sendJson(res, 200, {
      ok: true,
      sessionId: workspace.sessionId,
      threadId: thread.threadId,
      eventId: record.eventId
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    ignored: true
  });
}

function handleCompatEvents(res, searchParams, format = "memory") {
  const workspace = findWorkspace(asNonEmptyString(searchParams.get("sessionId")) ?? asNonEmptyString(searchParams.get("bridgeId")));
  if (!workspace) {
    sendJson(res, 404, { ok: false, error: "未找到会话" });
    return;
  }

  const thread = getCurrentThread(workspace, asNonEmptyString(searchParams.get("threadId")));
  if (!thread) {
    sendJson(res, 404, { ok: false, error: "未找到线程" });
    return;
  }

  const after = asFiniteNumber(searchParams.get("after"), 0);
  const excludeSource = asNonEmptyString(searchParams.get("excludeSource")) ?? "";
  const events = listCompatEvents(thread, after, excludeSource);

  sendJson(res, 200, {
    ok: true,
    sessionId: workspace.sessionId,
    bridgeId: workspace.sessionId,
    threadId: thread.threadId,
    nextCursor: thread.compatEvents.at(-1)?.eventId ?? 0,
    events: format === "legacy"
      ? events.map(compatEventToLegacyEnvelope)
      : events.map(simplifyCompatEvent)
  });
}

function handleCompatSession(res, searchParams) {
  const workspace = findWorkspace(asNonEmptyString(searchParams.get("sessionId")) ?? asNonEmptyString(searchParams.get("bridgeId")));
  if (!workspace) {
    sendJson(res, 404, { ok: false, error: "未找到会话" });
    return;
  }

  const thread = getCurrentThread(workspace, asNonEmptyString(searchParams.get("threadId")));

  sendJson(res, 200, {
    ok: true,
    session: {
      ...serializeWorkspace(workspace),
      thread: thread ? summarizeThread(thread) : null
    }
  });
}

function handleMemoryStream(req, res, searchParams, format = "memory") {
  const workspace = findWorkspace(asNonEmptyString(searchParams.get("sessionId")) ?? asNonEmptyString(searchParams.get("bridgeId")));
  if (!workspace) {
    sendJson(res, 404, { ok: false, error: "未找到会话" });
    return;
  }

  const thread = getCurrentThread(workspace, asNonEmptyString(searchParams.get("threadId")));
  if (!thread) {
    sendJson(res, 404, { ok: false, error: "未找到线程" });
    return;
  }

  sendSseHeaders(res);
  const stream = {
    res,
    threadId: thread.threadId,
    format
  };
  workspace.memoryStreams.add(stream);
  req.on("close", () => {
    workspace.memoryStreams.delete(stream);
  });
}

async function handleRpc(req, res) {
  const body = await readBody(req);
  const method = asNonEmptyString(body.method);
  const params = body.params ?? {};

  if (!method) {
    sendRpcError(res, 400, "缺少 RPC method");
    return;
  }

  try {
    if (method === "persona/select") {
      const result = await ensureWorkspaceAndThread(params);
      await ensureCodexThread(result.workspace, result.thread);
      persistWorkspace(result.workspace);
      sendRpcResult(res, {
        workspace: serializeWorkspace(result.workspace),
        thread: serializeThread(result.thread),
        avatarUrl: buildAvatarUrl(result.workspace.personId, result.workspace.sessionId, result.thread.threadId)
      });
      return;
    }

    if (method === "workspace/read") {
      const workspace = findWorkspace(asNonEmptyString(params.sessionId) ?? asNonEmptyString(params.personId));
      if (!workspace) {
        throw new Error("未找到会话");
      }

      sendRpcResult(res, {
        workspace: serializeWorkspace(workspace)
      });
      return;
    }

    if (method === "thread/list") {
      const workspace = findWorkspace(asNonEmptyString(params.sessionId) ?? asNonEmptyString(params.personId));
      if (!workspace) {
        throw new Error("未找到会话");
      }

      sendRpcResult(res, {
        workspace: serializeWorkspace(workspace)
      });
      return;
    }

    if (method === "thread/create") {
      const ensured = await ensureWorkspaceAndThread(params);
      const thread = await createThread(ensured.workspace, {
        title: params.title,
        reason: "rpc-thread-create"
      });
      persistWorkspace(ensured.workspace);
      sendRpcResult(res, {
        workspace: serializeWorkspace(ensured.workspace),
        thread: serializeThread(thread)
      });
      return;
    }

    if (method === "thread/select") {
      const workspace = findWorkspace(asNonEmptyString(params.sessionId) ?? asNonEmptyString(params.personId));
      if (!workspace) {
        throw new Error("未找到会话");
      }

      const thread = await selectThread(workspace, params.threadId);
      sendRpcResult(res, {
        workspace: serializeWorkspace(workspace),
        thread: serializeThread(thread)
      });
      return;
    }

    if (method === "thread/read") {
      const workspace = findWorkspace(asNonEmptyString(params.sessionId) ?? asNonEmptyString(params.personId));
      if (!workspace) {
        throw new Error("未找到会话");
      }

      const thread = getCurrentThread(workspace, asNonEmptyString(params.threadId));
      if (!thread) {
        throw new Error("未找到线程");
      }

      sendRpcResult(res, {
        workspace: serializeWorkspace(workspace),
        thread: serializeThread(thread)
      });
      return;
    }

    if (method === "turn/send") {
      const workspace = findWorkspace(asNonEmptyString(params.sessionId) ?? asNonEmptyString(params.personId));
      if (!workspace) {
        throw new Error("未找到会话");
      }

      const thread = getCurrentThread(workspace, asNonEmptyString(params.threadId));
      if (!thread) {
        throw new Error("未找到线程");
      }

      const result = await sendUserTurn(workspace, thread, params.text);
      sendRpcResult(res, {
        ...result,
        workspace: serializeWorkspace(workspace),
        thread: serializeThread(thread)
      });
      return;
    }

    if (method === "context/push") {
      const workspace = findWorkspace(asNonEmptyString(params.sessionId) ?? asNonEmptyString(params.personId));
      if (!workspace) {
        throw new Error("未找到会话");
      }

      const thread = getCurrentThread(workspace, asNonEmptyString(params.threadId));
      if (!thread) {
        throw new Error("未找到线程");
      }

      const entries = createContextEntries(params.entries ?? [], params.source ?? "codex-host");
      thread.contextEntries = params.replace ? entries : [...thread.contextEntries, ...entries];
      appendCompatEvent(
        workspace,
        thread,
        "context.updated",
        {
          entries,
          replace: Boolean(params.replace)
        },
        params.source ?? "codex-host"
      );
      publishNotification(workspace, {
        type: "context.updated",
        threadId: thread.threadId,
        payload: {
          entries,
          replace: Boolean(params.replace)
        }
      });
      persistWorkspace(workspace);
      sendRpcResult(res, {
        workspace: serializeWorkspace(workspace),
        thread: serializeThread(thread)
      });
      return;
    }

    sendRpcError(res, 404, `未知 RPC 方法：${method}`);
  } catch (error) {
    sendRpcError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

function handleNotificationStream(req, res, searchParams) {
  const workspace = findWorkspace(asNonEmptyString(searchParams.get("sessionId")) ?? asNonEmptyString(searchParams.get("personId")));
  if (!workspace) {
    sendJson(res, 404, { ok: false, error: "未找到会话" });
    return;
  }

  sendSseHeaders(res);
  const stream = { res };
  workspace.notificationStreams.add(stream);
  res.write(`data: ${JSON.stringify({
    type: "transport.ready",
    sessionId: workspace.sessionId,
    personId: workspace.personId,
    atIso: nowIso(),
    payload: {
      transport: "sse",
      workspace: serializeWorkspace(workspace)
    }
  })}\n\n`);
  req.on("close", () => {
    workspace.notificationStreams.delete(stream);
  });
}

function makeWebSocketAccept(key) {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function writeWebSocketText(socket, text) {
  const payload = Buffer.from(text);
  let header = null;

  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = payload.length;
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }

  socket.write(Buffer.concat([header, payload]));
}

function handleWebSocketUpgrade(req, socket, head) {
  const url = new URL(req.url, BRIDGE_SERVER_URL);
  if (url.pathname !== "/codex-api/ws") {
    socket.destroy();
    return;
  }

  const workspace = findWorkspace(asNonEmptyString(url.searchParams.get("sessionId")) ?? asNonEmptyString(url.searchParams.get("personId")));
  if (!workspace) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  const accept = makeWebSocketAccept(String(key));
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n"
    ].join("\r\n")
  );

  if (head?.length) {
    socket.unshift(head);
  }

  workspace.sockets.add(socket);
  writeWebSocketText(socket, JSON.stringify({
    type: "transport.ready",
    sessionId: workspace.sessionId,
    personId: workspace.personId,
    atIso: nowIso(),
    payload: {
      transport: "ws",
      workspace: serializeWorkspace(workspace)
    }
  }));

  const cleanup = () => {
    workspace.sockets.delete(socket);
  };

  socket.on("close", cleanup);
  socket.on("end", cleanup);
  socket.on("error", cleanup);
  socket.on("data", (data) => {
    const firstByte = data?.[0] ?? 0;
    const opcode = firstByte & 0x0f;
    if (opcode === 0x8) {
      cleanup();
      socket.end();
    }
  });
}

initializeWorkspacesFromState();

const server = http.createServer(async (req, res) => {
  cleanupExpiredWorkspaces();

  if (!req.url || !req.method) {
    sendJson(res, 400, { ok: false, error: "无效请求" });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    });
    res.end();
    return;
  }

  const url = new URL(req.url, BRIDGE_SERVER_URL);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        service: "moss-memory-app-server",
        legacyService: "moss-memory-bridge",
        host: HOST,
        port: BRIDGE_PORT,
        sessionCount: workspaces.size
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/codex-api/meta/methods") {
      sendJson(res, 200, {
        data: RPC_METHODS
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/codex-api/meta/notifications") {
      sendJson(res, 200, {
        data: NOTIFICATION_TYPES
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/codex-api/rpc") {
      await handleRpc(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/codex-api/events") {
      handleNotificationStream(req, res, url.searchParams);
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/persona/select" || url.pathname === "/api/memory/launch" || url.pathname === "/api/bridge/launch")) {
      await handleLaunch(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/persona/session") {
      const workspace = findWorkspace(asNonEmptyString(url.searchParams.get("sessionId")) ?? asNonEmptyString(url.searchParams.get("personId")));
      if (!workspace) {
        sendJson(res, 404, { ok: false, error: "未找到会话" });
        return;
      }

      const thread = getCurrentThread(workspace, asNonEmptyString(url.searchParams.get("threadId")));
      sendJson(res, 200, {
        ok: true,
        workspace: serializeWorkspace(workspace),
        thread: thread ? serializeThread(thread) : null
      });
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/memory/context" || url.pathname === "/api/bridge/context")) {
      await handleContext(req, res);
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/memory/event" || url.pathname === "/api/bridge/event")) {
      await handleMemoryEvent(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/memory/sync") {
      await handleSync(req, res);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/memory/events") {
      handleCompatEvents(res, url.searchParams, "memory");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/bridge/events") {
      handleCompatEvents(res, url.searchParams, "legacy");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/memory/session") {
      handleCompatSession(res, url.searchParams);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/memory/stream") {
      handleMemoryStream(req, res, url.searchParams, "memory");
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/bridge/stream") {
      handleMemoryStream(req, res, url.searchParams, "legacy");
      return;
    }

    sendJson(res, 404, { ok: false, error: "未找到接口" });
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

server.on("upgrade", handleWebSocketUpgrade);

server.listen(BRIDGE_PORT, HOST, () => {
  process.stdout.write(`moss-memory-app-server listening on ${BRIDGE_SERVER_URL}\n`);
});
