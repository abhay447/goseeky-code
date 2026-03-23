import { HybridStore } from "../core/search/hybridStore";
import { extractCodeSnippetFromFile } from "../core/parser/utils";
import { AgentTool } from "./types";

export class RepoSearch implements AgentTool {
  private hybridStore: HybridStore
  name: string
  toolDescription: string
  constructor(hybridStore: HybridStore) {
    this.hybridStore = hybridStore;
    this.name = 'RepoSearchTool'
    this.toolDescription= `This tools allows the agent to search the repo for a query string and returns matching source code entities. Argument Schema: {"query" : <string_to_search>}`
  }
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
    this.toolDescription = `Reads source for the entity_id requested. Argument Schema: {"entity_id" : <entity id from RepoSearchTool whose code is required by agent>}`;

  }
  async execute(input: Record<string, unknown>): Promise<string> {
    let entity = await this.hybridStore.getEntity(input.entity_id as string);
    if (entity.code?.endsWith("..")) {
      return extractCodeSnippetFromFile(
        entity.filePath,
        entity.startIndex!,
        entity.endIndex!,
        false
      )
    }
    return entity.code!;
  }

}