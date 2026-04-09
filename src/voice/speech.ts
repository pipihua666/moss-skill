import type { VoiceSessionState } from "../types";

interface SpeechControllerOptions {
  onTranscript: (text: string) => void;
  onStateChange: (state: VoiceSessionState, detail?: string) => void;
}

export class SpeechController {
  private recognition: SpeechRecognitionLike | null = null;
  private active = false;
  private readonly options: SpeechControllerOptions;

  constructor(options: SpeechControllerOptions) {
    this.options = options;
  }

  supportsRecognition(): boolean {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  startListening(): void {
    if (!this.supportsRecognition()) {
      this.options.onStateChange("unsupported", "当前浏览器不支持语音识别，请改用文字输入。");
      return;
    }

    if (!this.recognition) {
      const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Recognition) {
        this.options.onStateChange("unsupported", "当前浏览器不支持语音识别，请改用文字输入。");
        return;
      }

      this.recognition = new Recognition();
      this.recognition.continuous = false;
      this.recognition.interimResults = false;
      this.recognition.lang = "zh-CN";

      this.recognition.onstart = () => {
        this.active = true;
        this.options.onStateChange("listening");
      };

      this.recognition.onend = () => {
        if (!this.active) {
          this.options.onStateChange("idle");
          return;
        }

        this.active = false;
        this.options.onStateChange("processing", "我把你刚才的话捡起来了，机器人正在组织语言。");
      };

      this.recognition.onerror = (event) => {
        this.active = false;
        this.options.onStateChange("error", `语音识别出了点岔子：${event.error ?? "未知错误"}`);
      };

      this.recognition.onresult = (event) => {
        const text = Array.from({ length: event.results.length }, (_, index) => event.results[index])
          .map((result) => result[0]?.transcript ?? "")
          .join("")
          .trim();

        if (text) {
          this.options.onTranscript(text);
        }
      };
    }

    this.options.onStateChange("requesting-permission", "准备打开麦克风，请让浏览器别装聋。");

    try {
      this.recognition.start();
    } catch {
      this.options.onStateChange("error", "收音已经在路上了，别把机器人耳朵按出重影。");
    }
  }

  stopListening(): void {
    this.active = false;
    this.recognition?.stop();
    this.options.onStateChange("idle", "已停止收音，机器人把耳朵收回去了。");
  }

  async speak(text: string, voiceHint: string | undefined): Promise<void> {
    if (!("speechSynthesis" in window)) {
      this.options.onStateChange("error", "当前浏览器不支持语音播报。");
      return;
    }

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 0.95;
    utterance.pitch = 1;

    const voices = window.speechSynthesis.getVoices();
    const matchedVoice = voices.find((voice) =>
      voice.lang.toLowerCase().startsWith("zh") &&
      (voiceHint ? voice.name.includes(voiceHint) : true)
    );

    if (matchedVoice) {
      utterance.voice = matchedVoice;
    }

    this.options.onStateChange("speaking");

    await new Promise<void>((resolve) => {
      utterance.onend = () => {
        this.options.onStateChange("idle", "我说完了，机器人嘴不动了。");
        resolve();
      };
      utterance.onerror = () => {
        this.options.onStateChange("error", "语音播报出了点小脾气。");
        resolve();
      };
      window.speechSynthesis.speak(utterance);
    });
  }
}

export async function startVoiceSession(controller: SpeechController): Promise<void> {
  controller.startListening();
}

export function stopVoiceSession(controller: SpeechController): void {
  controller.stopListening();
}
