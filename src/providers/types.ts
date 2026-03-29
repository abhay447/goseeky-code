export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

export interface AIProvider {
  name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}

export interface ChatHistoryRecord {
  userQuery: string;
  agentResponse: string;
  timestamp?: number;
}