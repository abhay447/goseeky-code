import * as https from "https";
import { AIProvider, ChatMessage, ChatOptions } from "./types";

export class GeminiProvider implements AIProvider {
  name = "gemini";
  private readonly baseUrl = "generativelanguage.googleapis.com";
  private readonly model = "gemini-2.5-flash";

  constructor(private apiKey: string) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {},responseFormat: any| undefined = null): Promise<string> {
    // Convert messages to Gemini format
    // Gemini uses "user"/"model" roles, and system prompt is separate
    const systemMessage = messages.find(m => m.role === "system");
    const chatMessages = messages.filter(m => m.role !== "system");

    const contents = chatMessages.map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));

    const body = JSON.stringify({
      system_instruction: systemMessage
        ? { parts: [{ text: systemMessage.content }] }
        : undefined,
      contents,
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        // maxOutputTokens: options.maxTokens ?? 2048,
      }
    });

    return new Promise((resolve, reject) => {
      const path = `/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
      const req = https.request(
        {
          hostname: this.baseUrl,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Gemini API error ${res.statusCode}: ${data}`));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.candidates[0].content.parts[0].text);
            } catch (e) {
              reject(new Error(`Failed to parse Gemini response: ${data}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}