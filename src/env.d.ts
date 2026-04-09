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
  launchMemoryAvatar?: (
    personId: string,
    options?: {
      bridgeId?: string;
      context?: string | string[];
    }
  ) => void;
  mossMemoryBridge?: {
    launchAvatar: (
      personId: string,
      options?: {
        bridgeId?: string;
        context?: string | string[];
      }
    ) => void;
    pushContext: (entries: string | string[], replace?: boolean) => void;
    sendEnvelope: (data: unknown) => void;
  };
}
