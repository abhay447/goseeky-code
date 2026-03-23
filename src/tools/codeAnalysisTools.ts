import { HybridStore } from "../core/search/hybridStore";
import { extractEntityCode } from "../core/parser/utils";
import { AgentTool } from "./types";
import { AIProvider } from "../providers";

export class RepoSearch implements AgentTool {
  private hybridStore: HybridStore
  name: string
  toolDescription: string
  constructor(hybridStore: HybridStore) {
    this.hybridStore = hybridStore;
    this.name = 'RepoSearchTool'
    this.toolDescription= `This tools allows the agent to search the repo for a query string and returns matching source code entities. Argument Schema: {"query" : <string_to_search>}`
  }

  setAiProvider(client: AIProvider) {}
  async execute(input: Record<string, unknown>): Promise<string> {
    let result =  await this.hybridStore.search(input.query as string);
    // console.log("Search results" + result);
    return JSON.stringify(result);
  }

}

export class GetEntityCode implements AgentTool {
  private hybridStore: HybridStore;
  name: string
  toolDescription: string
  constructor(hybridStore: HybridStore) {
    this.hybridStore = hybridStore;
    this.name = `GetEntityCode`;
    this.toolDescription = `Reads source for the entity_id requested. Argument Schema: {"entity_id" : <entity id from RepoSearchTool whose code is required by agent,obtained by RepoSearchTool>}`;

  }
  setAiProvider(client: AIProvider) {}
  async execute(input: Record<string, unknown>): Promise<string> {
    return await extractEntityCode(input.entity_id as string, this.hybridStore);
  }

}

export class AnalyseEntityCode implements AgentTool {
  private hybridStore: HybridStore;
  name: string
  toolDescription: string
  client: AIProvider | null = null;

  constructor(hybridStore: HybridStore) {
    this.hybridStore = hybridStore;
    this.name = `AnalyseEntity`;
    this.toolDescription = `Allows Q&A and natural language analysis of entity by analysing entity code . Argument Schema: {"entity_id" : <entity id from RepoSearchTool whose code needs to be analysed, obtained by RepoSearchTool>, "analysis_prompt" : <user supplied prompt on how they want to analyse the code>}`;

  }
  isIntelligentTool(): boolean {
    return true;
  }

  setAiProvider(client: AIProvider) {
    this.client = client;
  }

  buildAnalysisPrompt(code: string, userPrompt: string) {
    return ` Given the code snippet below:
      '''
        ${code}
      ''' 

      Generate an appropriate response for user based on the below analysis prompt:
      '''
        ${userPrompt}
      '''
    `
  }
  async execute(input: Record<string, unknown>): Promise<string> {
    let code = await extractEntityCode(input.entity_id as string, this.hybridStore);
    let analysisSystemPrompt = this.buildAnalysisPrompt(code, input.analysis_prompt as string );
    return await this.client?.chat(
      [
        {
          "role" : "system",
          "content": analysisSystemPrompt
        }
      ]
    )!;
    
  }

}