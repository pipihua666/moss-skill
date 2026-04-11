import { spawn } from "node:child_process";
import readline from "node:readline";

const CODEX_BIN = process.platform === "win32" ? "codex.exe" : "codex";

function asError(error, fallback) {
  return error instanceof Error ? error : new Error(fallback);
}

export class CodexAppClient {
  constructor(options = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.child = null;
    this.readline = null;
    this.stderr = [];
    this.generation = 0;
    this.initialized = false;
    this.readyPromise = null;
    this.requestId = 1;
    this.pendingRequests = new Map();
    this.pendingTurns = new Map();
    this.notificationListeners = new Set();
  }

  async ensureReady() {
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = this.start();
    return this.readyPromise;
  }

  async start() {
    this.child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.generation += 1;
    this.stderr = [];
    this.initialized = false;

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      this.stderr.push(text);
      if (this.stderr.length > 200) {
        this.stderr.splice(0, this.stderr.length - 200);
      }
    });

    this.readline = readline.createInterface({
      input: this.child.stdout
    });

    this.readline.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      try {
        this.handleMessage(JSON.parse(line));
      } catch (error) {
        this.rejectAll(asError(error, "Codex app-server 返回了坏掉的 JSON，像把协议拿去泡茶了。"));
      }
    });

    this.child.on("error", (error) => {
      this.rejectAll(asError(error, "Codex app-server 没能启动。"));
    });

    this.child.on("close", (code, signal) => {
      const reason = signal
        ? `Codex app-server 被信号 ${signal} 关机了。`
        : `Codex app-server 提前退出，状态码 ${code ?? "unknown"}。`;
      const detail = this.stderr.slice(-20).join("");
      this.rejectAll(new Error(detail ? `${reason}\n${detail}` : reason));
      this.child = null;
      this.readline = null;
      this.readyPromise = null;
      this.initialized = false;
    });

    const response = await this.request("initialize", {
      clientInfo: {
        name: "moss-memory-sync",
        title: "MOSS Memory Sync",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: false
      }
    });

    if (!response?.userAgent) {
      throw new Error("Codex app-server 初始化没成功，像握手时两边都在比谁先眨眼。");
    }

    this.notify("initialized");
    this.initialized = true;
    return response;
  }

  async startThread(params) {
    await this.ensureReady();
    return this.request("thread/start", {
      cwd: params.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: params.developerInstructions,
      serviceName: "MOSS Memory Sync",
      ephemeral: false,
      experimentalRawEvents: false,
      persistExtendedHistory: false
    });
  }

  async resumeThread(params) {
    await this.ensureReady();
    return this.request("thread/resume", {
      threadId: params.threadId,
      cwd: params.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: params.developerInstructions,
      persistExtendedHistory: false
    });
  }

  async runTurn(params) {
    await this.ensureReady();

    if (this.pendingTurns.has(params.threadId)) {
      throw new Error(`thread ${params.threadId} 已经有进行中的 turn，别让两段回忆抢同一张嘴。`);
    }

    const pending = {
      threadId: params.threadId,
      turnId: null,
      textDeltas: [],
      completedMessages: [],
      completedTurn: null,
      resolve: null,
      reject: null
    };

    const completion = new Promise((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
    });

    this.pendingTurns.set(params.threadId, pending);

    try {
      const response = await this.request("turn/start", {
        threadId: params.threadId,
        input: [
          {
            type: "text",
            text: params.text,
            text_elements: []
          }
        ]
      });

      pending.turnId = response?.turn?.id ?? null;
      this.maybeResolveTurn(params.threadId);
      return await completion;
    } catch (error) {
      this.pendingTurns.delete(params.threadId);
      throw asError(error, "启动 turn 失败。");
    }
  }

  close() {
    this.readline?.close();
    this.child?.kill();
  }

  onNotification(listener) {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  notify(method, params) {
    this.write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params })
    });
  }

  request(method, params) {
    const id = this.requestId;
    this.requestId += 1;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method });
      this.write({
        jsonrpc: "2.0",
        id,
        method,
        ...(params === undefined ? {} : { params })
      });
    });
  }

  write(message) {
    if (!this.child?.stdin.writable) {
      throw new Error("Codex app-server stdin 不可写，像电话接通了但听筒被偷了。");
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pendingRequests.get(message.id);

      if (!pending) {
        return;
      }

      this.pendingRequests.delete(message.id);

      if (message.error) {
        const detail = typeof message.error?.data === "string"
          ? `\n${message.error.data}`
          : "";
        pending.reject(new Error(`${message.error?.message ?? "Codex app-server 请求失败"}${detail}`));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (!message?.method) {
      return;
    }

    const { method, params } = message;
    this.emitNotification(method, params);

    switch (method) {
      case "item/agentMessage/delta": {
        const pending = this.pendingTurns.get(params.threadId);
        if (pending) {
          pending.textDeltas.push(String(params.delta ?? ""));
        }
        break;
      }
      case "item/completed": {
        const pending = this.pendingTurns.get(params.threadId);
        if (pending && params.item?.type === "agentMessage") {
          pending.completedMessages.push(String(params.item.text ?? ""));
        }
        break;
      }
      case "turn/completed": {
        const pending = this.pendingTurns.get(params.threadId);
        if (pending) {
          pending.completedTurn = params.turn ?? null;
          this.maybeResolveTurn(params.threadId);
        }
        break;
      }
      default:
        break;
    }
  }

  maybeResolveTurn(threadId) {
    const pending = this.pendingTurns.get(threadId);

    if (!pending?.completedTurn || !pending.turnId) {
      return;
    }

    this.pendingTurns.delete(threadId);
    const text = pending.completedMessages.at(-1) ?? pending.textDeltas.join("");
    pending.resolve({
      threadId,
      turnId: pending.turnId,
      status: pending.completedTurn.status ?? "completed",
      text: text.trim(),
      turn: pending.completedTurn
    });
  }

  emitNotification(method, params) {
    for (const listener of this.notificationListeners) {
      try {
        listener({
          method,
          params
        });
      } catch {
        // 监听器自己翻车时，不要把主桥一起掀进沟里。
      }
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(id);
      pending.reject(error);
    }

    for (const [threadId, pending] of this.pendingTurns.entries()) {
      this.pendingTurns.delete(threadId);
      pending.reject(error);
    }
  }
}
