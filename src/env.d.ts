/// <reference types="vite/client" />

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: {
    readonly transcript: string;
  };
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

interface Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
  launchMemoryUser?: (
    personId: string,
    options?: {
      sessionId?: string;
      bridgeId?: string;
      threadId?: string;
      context?: string | string[];
      serverUrl?: string;
      bridgeServerUrl?: string;
    }
  ) => void;
  launchMemoryAvatar?: (
    personId: string,
    options?: {
      sessionId?: string;
      bridgeId?: string;
      threadId?: string;
      context?: string | string[];
      serverUrl?: string;
      bridgeServerUrl?: string;
    }
  ) => void;
  mossCodexUI?: {
    open: (
      personId: string,
      options?: {
        sessionId?: string;
        bridgeId?: string;
        threadId?: string;
        context?: string | string[];
        serverUrl?: string;
        bridgeServerUrl?: string;
      }
    ) => void;
  };
  mossMemoryBridge?: {
    launchUser: (
      personId: string,
      options?: {
        sessionId?: string;
        bridgeId?: string;
        threadId?: string;
        context?: string | string[];
        serverUrl?: string;
        bridgeServerUrl?: string;
      }
    ) => void;
    launchAvatar: (
      personId: string,
      options?: {
        sessionId?: string;
        bridgeId?: string;
        threadId?: string;
        context?: string | string[];
        serverUrl?: string;
        bridgeServerUrl?: string;
      }
    ) => void;
    pushContext: (entries: string | string[], replace?: boolean) => void;
    sendEnvelope: (data: unknown) => void;
  };
}
