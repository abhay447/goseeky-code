import * as https from "https";
import { AIProvider, ChatMessage, ChatOptions } from "./types";

export class SarvamProvider implements AIProvider {
  name = "sarvam";
  private readonly baseUrl = "api.sarvam.ai";
  private readonly model = "sarvam-m";

  constructor(private apiKey: string) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 2048,
      stream: false,
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: this.baseUrl,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-subscription-key": this.apiKey,
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Sarvam API error ${res.statusCode}: ${data}`));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              resolve(parsed.choices[0].message.content);
            } catch (e) {
              reject(new Error(`Failed to parse response: ${data}`));
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