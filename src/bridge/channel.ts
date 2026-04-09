import type {
  BridgeEnvelope,
  BridgeEventType,
  BridgePayloadMap,
  SharedContextEntry
} from "../types";

interface MemoryBridgeOptions {
  bridgeId: string;
  personId: string;
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

export class MemoryBridge {
  private readonly bridgeId: string;
  private readonly personId: string;
  private readonly channel: BroadcastChannel | null;
  private readonly onContextUpdate?: (entries: SharedContextEntry[], replace: boolean) => void;

  constructor(options: MemoryBridgeOptions) {
    this.bridgeId = options.bridgeId;
    this.personId = options.personId;
    this.onContextUpdate = options.onContextUpdate;
    this.channel = "BroadcastChannel" in window
      ? new BroadcastChannel(`moss-avatar:${this.bridgeId}`)
      : null;

    this.channel?.addEventListener("message", this.handleChannelMessage);
    window.addEventListener("message", this.handleWindowMessage);
  }

  announceReady(): void {
    this.emit("bridge:ready", {
      bridgeId: this.bridgeId,
      personId: this.personId
    });
    this.requestContext("avatar-page-mounted");
  }

  requestContext(reason: string): void {
    this.emit("bridge:request-context", { reason });
  }

  syncContext(entries: SharedContextEntry[], replace = false): void {
    this.emit("bridge:context-update", { entries, replace });
  }

  syncUserMessage(text: string): void {
    this.emit("bridge:user-message", {
      text,
      personId: this.personId
    });
  }

  syncPersonaMessage(text: string): void {
    this.emit("bridge:persona-message", {
      text,
      personId: this.personId
    });
  }

  syncStatus(state: string, detail?: string): void {
    this.emit("bridge:status", { state, detail });
  }

  destroy(): void {
    this.channel?.removeEventListener("message", this.handleChannelMessage);
    this.channel?.close();
    window.removeEventListener("message", this.handleWindowMessage);
  }

  private emit<T extends BridgeEventType>(
    type: T,
    payload: BridgePayloadMap[T]
  ): void {
    const envelope: BridgeEnvelope<T> = {
      type,
      bridgeId: this.bridgeId,
      payload
    };

    this.channel?.postMessage(envelope);

    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(envelope, "*");
    }

    window.dispatchEvent(new CustomEvent("moss:bridge-message", { detail: envelope }));
  }

  private handleIncomingEnvelope = (envelope: BridgeEnvelope): void => {
    if (envelope.bridgeId !== this.bridgeId) {
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
}
