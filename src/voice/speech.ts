import type { VoiceSessionState } from "../types";

interface SpeechControllerOptions {
  onTranscript: (text: string) => void;
  onStateChange: (state: VoiceSessionState, detail?: string) => void;
  onCaptureComplete?: (text: string) => void;
}

export class SpeechController {
  private recognition: SpeechRecognitionLike | null = null;
  private listening = false;
  private finishing = false;
  private failed = false;
  private transcriptBuffer = "";

  constructor(private readonly options: SpeechControllerOptions) {}

  supportsRecognition(): boolean {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  isListening(): boolean {
    return this.listening;
  }

  startListening(): void {
    if (!this.supportsRecognition()) {
      this.options.onStateChange("unsupported", "当前浏览器不支持语音识别，请改用文字输入。");
      return;
    }

    this.ensureRecognition();

    if (!this.recognition) {
      this.options.onStateChange("unsupported", "当前浏览器不支持语音识别，请改用文字输入。");
      return;
    }

    if (this.listening) {
      this.options.onStateChange("error", "机器人已经在听了，别把空格键按成拍砖现场。");
      return;
    }

    this.transcriptBuffer = "";
    this.finishing = false;
    this.failed = false;
    this.options.onTranscript("");
    this.options.onStateChange("requesting-permission", "准备打开麦克风，请让浏览器别突然装聋。");

    try {
      this.recognition.start();
    } catch {
      this.options.onStateChange("error", "收音已经在路上了，别把机器人耳朵按出重影。");
    }
  }

  finishListening(): void {
    if (!this.recognition || !this.listening) {
      this.options.onStateChange("idle", "这次没收成语音，像是对着空气打了个响指。");
      return;
    }

    this.finishing = true;
    this.options.onStateChange("processing", "松开空格了，虚拟人正在接住这句话。");
    this.recognition.stop();
  }

  cancelListening(): void {
    if (!this.recognition || !this.listening) {
      this.options.onStateChange("idle", "已停止收音，机器人把耳朵折回去了。");
      return;
    }

    this.finishing = false;
    this.listening = false;
    this.recognition.stop();
    this.options.onStateChange("idle", "已停止收音，机器人把耳朵折回去了。");
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

  private ensureRecognition(): void {
    if (this.recognition) {
      return;
    }

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      return;
    }

    this.recognition = new Recognition();
    this.recognition.continuous = false;
    this.recognition.interimResults = true;
    this.recognition.lang = "zh-CN";

    this.recognition.onstart = () => {
      this.listening = true;
      this.options.onStateChange("listening", "按住空格继续说，松开就发给虚拟人。");
    };

    this.recognition.onend = () => {
      const shouldSubmit = this.finishing;
      const failed = this.failed;
      const transcript = this.transcriptBuffer.trim();

      this.listening = false;
      this.finishing = false;
      this.failed = false;

      if (failed) {
        return;
      }

      if (shouldSubmit) {
        if (transcript) {
          this.options.onStateChange("processing", "虚拟人正在整理你刚才的话。");
          this.options.onCaptureComplete?.(transcript);
        } else {
          this.options.onStateChange("idle", "我刚才只听见一阵风，你再说一遍。");
        }
        return;
      }

      if (transcript) {
        this.options.onStateChange("idle", "收音结束，内容已经留在输入框里。");
        return;
      }

      this.options.onStateChange("idle");
    };

    this.recognition.onerror = (event) => {
      this.listening = false;
      this.finishing = false;
      this.failed = true;
      this.options.onStateChange("error", `语音识别出了点岔子：${event.error ?? "未知错误"}`);
    };

    this.recognition.onresult = (event) => {
      const text = Array.from({ length: event.results.length }, (_, index) => event.results[index])
        .map((result) => result[0]?.transcript ?? "")
        .join("")
        .trim();

      this.transcriptBuffer = text;
      this.options.onTranscript(text);
    };
  }
}

export async function startVoiceSession(controller: SpeechController): Promise<void> {
  controller.startListening();
}

export function stopVoiceSession(
  controller: SpeechController,
  options?: { submit?: boolean }
): void {
  if (options?.submit) {
    controller.finishListening();
    return;
  }

  controller.cancelListening();
}
