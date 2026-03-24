import { AgentTool } from "./types";
import { runShell } from "../utils/shellUtils";
import { AIProvider } from "../providers";

export class ShellExecute implements AgentTool {
  name: string
  toolDescription: string
  constructor() {
    this.name = 'ShellExecute'
    this.toolDescription = "Use this tool for environmental observation, file system operations, and repository metadata. This is the primary tool for inspecting the state of the workspace, counting assets, or performing operations that do not require semantic code understanding. Argument Schema: {\"shell_command\" : <shell_script>}"
  }

  setAiProvider(client: AIProvider) {}

  async execute(input: Record<string, unknown>): Promise<string> {
    let result = await runShell(input.shell_command as string);
    return JSON.stringify(result)
  }

}