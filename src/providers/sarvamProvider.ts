import * as https from "https";
import { AIProvider, ChatMessage, ChatOptions } from "./types";

export class SarvamProvider implements AIProvider {
  name = "sarvam";
  private readonly baseUrl = "api.sarvam.ai";
  private readonly model = "sarvam-105b";

  constructor(private apiKey: string) {}

  async chat(messages: ChatMessage[], options: ChatOptions = {}, responseFormat: any| undefined = null): Promise<string> {
  const body: any = {
    model: this.model,
    messages,
    temperature: options.temperature ?? 0.2,
    stream: false,
  };

  if (responseFormat) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "agent_response",
        schema: responseFormat,
        strict: true, // 🔥 important
      },
    };
  }

  const finalBody = JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: this.baseUrl,
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "api-subscription-key": this.apiKey,
            "Content-Length": Buffer.byteLength(finalBody),
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
              console.log("Sarvam Client failed with error ",e)
              console.log(data)
              reject(new Error(`Failed to parse response: ${data}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(finalBody);
      req.end();
    });
  }
}