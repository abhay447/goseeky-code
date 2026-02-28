// export async function streamSarvam(
//   prompt: string,
//   onChunk: (text: string) => void
// ) {
//   const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
//     method: "POST",
//     headers: {
//       "Authorization": `Bearer ${process.env.SARVAM_API_KEY}`,
//       "Content-Type": "application/json"
//     },
//     body: JSON.stringify({
//       model: "sarvam-m",
//       messages: [
//         { role: "user", content: prompt }
//       ],
//       stream: true
//     })
//   });

//   if (!res.body) throw new Error("No response body");

//   const reader = res.body.getReader();
//   const decoder = new TextDecoder();

//   while (true) {
//     const { done, value } = await reader.read();
//     if (done) break;
//     onChunk(decoder.decode(value));
//   }
// }

import * as https from "https";

export interface SarvamMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SarvamResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class SarvamClient {
  private readonly baseUrl = "api.sarvam.ai";
  private readonly model = "sarvam-m";

  constructor(private apiKey: string) {}

  async chat(
    messages: SarvamMessage[],
    options: { temperature?: number; maxTokens?: number; stream?: boolean } = {}
  ): Promise<string> {
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
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Sarvam API error ${res.statusCode}: ${data}`));
              return;
            }
            try {
              const parsed: SarvamResponse = JSON.parse(data);
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

  // Streaming version using async generator
  async *chatStream(
    messages: SarvamMessage[],
    options: { temperature?: number } = {}
  ): AsyncGenerator<string> {
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.2,
      stream: true,
    });

    const chunks: string[] = await new Promise((resolve, reject) => {
      const allChunks: string[] = [];
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
          let buffer = "";
          res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data !== "[DONE]") {
                  try {
                    const parsed = JSON.parse(data);
                    const content = parsed.choices?.[0]?.delta?.content;
                    if (content) allChunks.push(content);
                  } catch {}
                }
              }
            }
          });
          res.on("end", () => resolve(allChunks));
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    for (const chunk of chunks) {
      yield chunk;
    }
  }
}