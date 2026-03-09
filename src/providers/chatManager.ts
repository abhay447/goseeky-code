import * as vscode from "vscode";
import { AIProvider, ChatMessage, ChatOptions } from "./types";

const MAX_MESSAGES = 20;
const MAX_TOKENS = 30000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Strip reasoning blocks from model output ──────────────────────────────────
function stripThinkingBlocks(text: string): string {
    // Remove fully closed <think>...</think> blocks
    let result = text
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");

    // For unclosed <think> — just remove the opening tag, keep the content after it
    result = result.replace(/<think>/gi, "").replace(/<thinking>/gi, "");

    return result.trim();
}

export class ChatManager {
  private history: ChatMessage[] = [];
  private readonly storageKey = "goseeky.chatHistory";

  constructor(private context: vscode.ExtensionContext) {
    this.history = this.context.globalState.get<ChatMessage[]>(this.storageKey, []);
  }

  clear() {
    this.history = [];
    this.context.globalState.update(this.storageKey, []);
  }

  getHistory(systemMsg: ChatMessage, userMsg: ChatMessage): ChatMessage[] {
    const systemTokens = estimateTokens(systemMsg.content);
    const userTokens = estimateTokens(userMsg.content);
    let remainingTokens = MAX_TOKENS - systemTokens - userTokens;

    const trimmed: ChatMessage[] = [];
    const recent = this.history.slice(-MAX_MESSAGES);

    for (let i = recent.length - 1; i >= 0; i--) {
      const msg = recent[i];
      const tokens = estimateTokens(msg.content);
      if (remainingTokens - tokens < 0) { break; }
      trimmed.unshift(msg);
      remainingTokens -= tokens;
    }

    while (trimmed.length > 0 && trimmed[0].role !== "user") {
      trimmed.shift();
    }

    return [systemMsg, ...trimmed, userMsg];
  }

  async chat(
    client: AIProvider,
    systemMsg: ChatMessage,
    userMsg: ChatMessage,
    options?: ChatOptions
  ): Promise<string> {
    const messages = this.getHistory(systemMsg, userMsg);
    const rawReply = await client.chat(messages, options);

    // console.log("=== RAW FROM API ===");
    // console.log(JSON.stringify(rawReply));
    // console.log("=== END RAW FROM API ===");

    // Strip thinking blocks before storing in history or returning
    const reply = stripThinkingBlocks(rawReply);

    // console.log("=== AFTER STRIP ===");
    // console.log(JSON.stringify(reply));
    // console.log("=== END AFTER STRIP ===");

    this.history.push(userMsg);
    this.history.push({ role: "assistant", content: reply });

    await this.context.globalState.update(this.storageKey, this.history);

    return reply;
  }

  size(): number {
    return this.history.length;
  }
}