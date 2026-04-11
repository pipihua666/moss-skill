import type {
  BridgeEnvelope,
  BridgeEventType,
  BridgePayloadMap,
  MemoryEvent,
  MemoryEventType,
  MemoryEventPayloadMap,
  SharedContextEntry
} from "../types";

interface MemoryBridgeOptions {
  sessionId?: string;
  bridgeId?: string;
  personId: string;
  serverUrl?: string | null;
  bridgeServerUrl?: string | null;
  onContextUpdate?: (entries: SharedContextEntry[], replace: boolean) => void;
}

function isBridgeEnvelope(value: unknown): value is BridgeEnvelope {
  return Boolean(
    value &&
    typeof value === "object" &&
    "type" in value &&
    "bridgeId" in value &&
    "payload" in value
  );
}

function isMemoryEvent(value: unknown): value is MemoryEvent {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      "sessionId" in value &&
      "payload" in value
  );
}

export class MemoryBridge {
  private readonly sessionId: string;
  private readonly personId: string;
  private readonly serverUrl: string | null;
  private readonly channel: BroadcastChannel | null;
  private readonly eventSource: EventSource | null;
  private readonly onContextUpdate?: (entries: SharedContextEntry[], replace: boolean) => void;

  constructor(options: MemoryBridgeOptions) {
    this.sessionId = options.sessionId ?? options.bridgeId ?? crypto.randomUUID();
    this.personId = options.personId;
    this.serverUrl = (options.serverUrl ?? options.bridgeServerUrl)
      ? (options.serverUrl ?? options.bridgeServerUrl)!.replace(/\/$/, "")
      : null;
    this.onContextUpdate = options.onContextUpdate;
    this.channel = !this.serverUrl && "BroadcastChannel" in window
      ? new BroadcastChannel(`moss-avatar:${this.sessionId}`)
      : null;
    this.eventSource = this.serverUrl
      ? new EventSource(`${this.serverUrl}/api/memory/stream?sessionId=${encodeURIComponent(this.sessionId)}`)
      : null;

    this.channel?.addEventListener("message", this.handleChannelMessage);
    window.addEventListener("message", this.handleWindowMessage);
    this.eventSource?.addEventListener("message", this.handleEventSourceMessage);
  }

  announceReady(): void {
    this.emit("session.started", {
      reason: "avatar-page-mounted"
    }, {
      personId: this.personId
    });
    this.requestContext("avatar-page-mounted");
  }

  requestContext(reason: string): void {
    this.emit("sync.requested", { reason });
  }

  syncContext(entries: SharedContextEntry[], replace = false): void {
    this.emit("context.updated", { entries, replace });
  }

  syncUserMessage(text: string): void {
    this.emit("user.message", { text });
  }

  syncPersonaMessage(text: string): void {
    this.emit("persona.message", { text });
  }

  syncStatus(state: string, detail?: string): void {
    this.emit("status.changed", { state, detail });
  }

  destroy(): void {
    this.channel?.removeEventListener("message", this.handleChannelMessage);
    this.channel?.close();
    window.removeEventListener("message", this.handleWindowMessage);
    this.eventSource?.removeEventListener("message", this.handleEventSourceMessage);
    this.eventSource?.close();
  }

  private emit<T extends MemoryEventType>(
    type: T,
    payload: MemoryEventPayloadMap[T],
    options?: {
      personId?: string;
    }
  ): void {
    const event: MemoryEvent<T> = {
      type,
      sessionId: this.sessionId,
      bridgeId: this.sessionId,
      personId: options?.personId ?? this.personId,
      payload,
      source: "avatar-page",
      timestamp: Date.now()
    };

    if (this.serverUrl) {
      void fetch(`${this.serverUrl}/api/memory/event`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(event)
      }).catch(() => {
        // 宿主桥断线时不打断页面内对话，最多就是桥像打盹。
      });
    } else {
      const envelope = this.toLegacyEnvelope(type, payload);
      this.channel?.postMessage(envelope);

      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(envelope, "*");
      }
    }

    window.dispatchEvent(new CustomEvent("moss:bridge-message", { detail: event }));
  }

  private toLegacyEnvelope<T extends MemoryEventType>(
    type: T,
    payload: MemoryEventPayloadMap[T]
  ): BridgeEnvelope<BridgeEventType> {
    switch (type) {
      case "session.started": {
        return {
          type: "bridge:ready",
          bridgeId: this.sessionId,
          sessionId: this.sessionId,
          source: "avatar-page",
          timestamp: Date.now(),
          payload: {
            personId: this.personId,
            bridgeId: this.sessionId
          }
        };
      }
      case "context.updated": {
        const contextPayload = payload as MemoryEventPayloadMap["context.updated"];
        return {
          type: "bridge:context-update",
          bridgeId: this.sessionId,
          sessionId: this.sessionId,
          source: "avatar-page",
          timestamp: Date.now(),
          payload: contextPayload
        };
      }
      case "user.message": {
        const userPayload = payload as MemoryEventPayloadMap["user.message"];
        return {
          type: "bridge:user-message",
          bridgeId: this.sessionId,
          sessionId: this.sessionId,
          source: "avatar-page",
          timestamp: Date.now(),
          payload: {
            text: userPayload.text,
            personId: this.personId
          }
        };
      }
      case "persona.message": {
        const personaPayload = payload as MemoryEventPayloadMap["persona.message"];
        return {
          type: "bridge:persona-message",
          bridgeId: this.sessionId,
          sessionId: this.sessionId,
          source: "avatar-page",
          timestamp: Date.now(),
          payload: {
            text: personaPayload.text,
            personId: this.personId
          }
        };
      }
      case "status.changed": {
        const statusPayload = payload as MemoryEventPayloadMap["status.changed"];
        return {
          type: "bridge:status",
          bridgeId: this.sessionId,
          sessionId: this.sessionId,
          source: "avatar-page",
          timestamp: Date.now(),
          payload: statusPayload
        };
      }
      case "sync.requested":
      default:
        const syncPayload = payload as MemoryEventPayloadMap["sync.requested"];
        return {
          type: "bridge:request-context",
          bridgeId: this.sessionId,
          sessionId: this.sessionId,
          source: "avatar-page",
          timestamp: Date.now(),
          payload: {
            reason: syncPayload.reason
          }
        };
    }
  }

  private handleIncomingEnvelope = (envelope: BridgeEnvelope): void => {
    if (envelope.bridgeId !== this.sessionId) {
      return;
    }

    if (envelope.type === "bridge:context-update") {
      const payload = envelope.payload as BridgePayloadMap["bridge:context-update"];
      this.onContextUpdate?.(
        payload.entries,
        payload.replace ?? false
      );
    }
  };

  private handleIncomingEvent = (event: MemoryEvent): void => {
    if (event.sessionId !== this.sessionId) {
      return;
    }

    if (event.type === "context.updated") {
      const payload = event.payload as MemoryEventPayloadMap["context.updated"];
      this.onContextUpdate?.(
        payload.entries,
        payload.replace ?? false
      );
    }
  };

  private handleChannelMessage = (event: MessageEvent<BridgeEnvelope>): void => {
    if (isBridgeEnvelope(event.data)) {
      this.handleIncomingEnvelope(event.data);
    }
  };

  private handleWindowMessage = (event: MessageEvent): void => {
    if (isBridgeEnvelope(event.data)) {
      this.handleIncomingEnvelope(event.data);
    }
  };

  private handleEventSourceMessage = (event: MessageEvent<string>): void => {
    try {
      const parsed = JSON.parse(event.data) as BridgeEnvelope | MemoryEvent;
      if (isMemoryEvent(parsed)) {
        this.handleIncomingEvent(parsed);
        return;
      }

      if (isBridgeEnvelope(parsed)) {
        this.handleIncomingEnvelope(parsed);
      }
    } catch {
      // SSE 里如果混进脏数据，就当它去桥下喂鱼了。
    }
  };
}
