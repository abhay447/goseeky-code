import * as vscode from "vscode";
import { AIProvider, ChatMessage, ChatOptions } from "./types";

const MAX_TOKENS = 9000;
const MAX_MESSAGES = MAX_TOKENS / 300;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Strip reasoning/tool blocks from model output ─────────────────────────────
function stripThinkingBlocks(text: string): string {
  // Remove fully closed <think>...</think> blocks
  let result = text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");

  // For unclosed <think> — just remove the opening tag, keep content after it
  result = result.replace(/<think>/gi, "").replace(/<thinking>/gi, "");

  // Salvage <tool_call> blocks that contain a shell command in <arg_value>
  // e.g. <tool_call>run-shell\n<arg_key>command</arg_key>\n<arg_value>ls -la</arg_value>\n</tool_call>
  result = result.replace(
    /<tool_call>[\s\S]*?<arg_value>([\s\S]*?)<\/arg_value>[\s\S]*?<\/tool_call>/gi,
    (_, cmd) => `<run-shell>${cmd.trim()}</run-shell>`
  );

  // Salvage unclosed tool_call with arg_value but no closing tool_call tag
  result = result.replace(
    /<tool_call>[\s\S]*?<arg_value>([\s\S]*?)<\/arg_value>/gi,
    (_, cmd) => `<run-shell>${cmd.trim()}</run-shell>`
  );

  // Strip any remaining tool_call / function_call blocks entirely
  result = result
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<function_call>[\s\S]*?<\/function_call>/gi, "")
    .replace(/<arg_key>[\s\S]*?<\/arg_key>/gi, "")
    .replace(/<arg_value>[\s\S]*?<\/arg_value>/gi, "");

  return result.trim();
}

// ── Truncate a single message if it's too long ────────────────────────────────
function truncateMessage(msg: ChatMessage, maxTokens: number): ChatMessage {
  const tokens = estimateTokens(msg.content);
  if (tokens <= maxTokens) { return msg; }
  const maxChars = maxTokens * 4;
  return { ...msg, content: msg.content.slice(0, maxChars) + "\n...[truncated]" };
}

export class ChatManager {
  private history: ChatMessage[] = [];
  private storageKey: string;

  constructor(private context: vscode.ExtensionContext, private historyKey: string = "goseeky.chatHistory") {
    this.storageKey = historyKey;
    this.history = this.context.globalState.get<ChatMessage[]>(this.storageKey, []);
  }

  clear() {
    this.history = [];
    this.context.globalState.update(this.storageKey, []);
  }

  getHistory(systemMsg: ChatMessage, userMsg: ChatMessage): ChatMessage[] {
    const safeSystemMsg = truncateMessage(systemMsg, MAX_TOKENS / 2);
    const safeUserMsg = truncateMessage(userMsg, MAX_TOKENS / 2);

    const systemTokens = estimateTokens(safeSystemMsg.content);
    const userTokens = estimateTokens(safeUserMsg.content);
    const reservedForResponse = MAX_TOKENS / 3;
    let remainingTokens = MAX_TOKENS - systemTokens - userTokens - reservedForResponse;

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

    return [safeSystemMsg, ...trimmed, safeUserMsg];
  }

  async chat(
    client: AIProvider,
    systemMsg: ChatMessage,
    userMsg: ChatMessage,
    options?: ChatOptions
  ): Promise<string> {
    const messages = this.getHistory(systemMsg, userMsg);
    console.log("messages : " + JSON.stringify(messages))
    const rawReply = await client.chat(messages, options);
    console.log("raw reply:", rawReply);
    const reply = stripThinkingBlocks(rawReply);

    this.history.push(userMsg);
    this.history.push({ role: "assistant", content: reply });

    await this.context.globalState.update(this.storageKey, this.history);

    return reply;
  }

  size(): number {
    return this.history.length;
  }
}