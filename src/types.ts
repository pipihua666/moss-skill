export interface MemoryIndex {
  name: string;
  aliases: string[];
  file: string;
  relationship: string;
  status: string;
  lastUpdated: string;
}

export interface PersonProfile {
  name: string;
  aliases: string[];
  relationship: string;
  howUserRefersToThem: string;
  status: string;
  lastUpdated: string;
  speakingStyle: {
    catchphrases: string[];
    tone: string;
    rhythm: string;
    commonWords: string[];
  };
  behaviorStyle: {
    habits: string[];
    gestures: string[];
    decisionPattern: string;
    showCare: string;
    conflictStyle: string;
  };
  keyMemories: {
    memorableScene: string;
    linkedObjectOrPlace: string;
    smallDetails: string;
  };
  boundaries: string;
  openQuestions: string[];
  rawMarkdown: string;
}

export type VoiceSessionState =
  | "idle"
  | "requesting-permission"
  | "listening"
  | "processing"
  | "speaking"
  | "unsupported"
  | "error";

export interface ConversationTurn {
  id: string;
  speaker: "user" | "persona" | "system";
  text: string;
  timestamp: number;
}

export interface PersonaReplyInput {
  profile: PersonProfile;
  turns: ConversationTurn[];
  input: string;
}

export interface PersonaReplyResult {
  text: string;
  boundaryTriggered: boolean;
  suggestedFollowUp?: string;
}

export interface SharedContextEntry {
  id: string;
  source: string;
  text: string;
  timestamp: number;
}

export type BridgeSource =
  | "avatar-page"
  | "codex-host"
  | "codex-app"
  | "bridge-server"
  | "browser-host"
  | string;

export type MemoryEventType =
  | "session.started"
  | "context.updated"
  | "user.message"
  | "persona.message"
  | "status.changed"
  | "sync.requested";

export interface MemoryEventPayloadMap {
  "session.started": {
    reason?: string;
  };
  "context.updated": {
    entries: SharedContextEntry[];
    replace?: boolean;
  };
  "user.message": {
    text: string;
  };
  "persona.message": {
    text: string;
  };
  "status.changed": {
    state: string;
    detail?: string;
  };
  "sync.requested": {
    reason: string;
    unreadCount?: number;
  };
}

export type MemoryEvent<T extends MemoryEventType = MemoryEventType> = {
  type: T;
  sessionId: string;
  bridgeId?: string;
  threadId?: string;
  personId?: string;
  payload: MemoryEventPayloadMap[T];
  source?: BridgeSource;
  timestamp?: number;
  eventId?: number;
};

export type BridgeEventType =
  | "bridge:ready"
  | "bridge:request-context"
  | "bridge:context-update"
  | "bridge:user-message"
  | "bridge:persona-message"
  | "bridge:status";

export interface BridgePayloadMap {
  "bridge:ready": {
    personId: string;
    bridgeId: string;
  };
  "bridge:request-context": {
    reason: string;
  };
  "bridge:context-update": {
    entries: SharedContextEntry[];
    replace?: boolean;
  };
  "bridge:user-message": {
    text: string;
    personId: string;
  };
  "bridge:persona-message": {
    text: string;
    personId: string;
  };
  "bridge:status": {
    state: string;
    detail?: string;
  };
}

export type BridgeEnvelope<T extends BridgeEventType = BridgeEventType> = {
  type: T;
  bridgeId: string;
  payload: BridgePayloadMap[T];
  sessionId?: string;
  threadId?: string;
  source?: BridgeSource;
  timestamp?: number;
  eventId?: number;
};
