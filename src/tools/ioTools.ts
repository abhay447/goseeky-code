import { AgentTool } from "./types";
import { runShell } from "../utils/shellUtils";
import { AIProvider } from "../providers";

export class SendToUser implements AgentTool {
  name: string
  toolDescription: string
  constructor() {
    this.name = 'SendToUser'
    this.toolDescription = `
        This tools allows the agent to send messages to user.
        Apart from usual communication notes this tool is also ideal for sending information to user if there is no relevant action that the agent can take.
        Argument Schema: {\"message\" : <msg to user>}
    `
  }

  setAiProvider(client: AIProvider) {}

  async execute(input: Record<string, unknown>): Promise<string> {
    return (input.message as string);
  }

}