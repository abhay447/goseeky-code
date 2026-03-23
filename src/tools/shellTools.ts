import { AgentTool } from "./types";
import { runShell } from "../utils/shellUtils";

export class ShellExecute implements AgentTool {
  name: string
  toolDescription: string
  constructor() {
    this.name = 'ShellExecute'
    this.toolDescription = `
      This tools allows the agent to execute shell commands. 
      Use it only when other tools are not relevant for current goal. 
      Try not to load a lot of data in memory , use piped/ chained shell execution if possible.
      Argument Schema: {"shell_command" : <shell_script>}
    `
  }
  async execute(input: Record<string, unknown>): Promise<string> {
    let result = await runShell(input.shell_command as string);
    return JSON.stringify(result)
  }

}