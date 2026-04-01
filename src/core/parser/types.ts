// src/core/types.ts
export type EntityType =
  | "function"
  | "class"
  | "method"
  | "variable"
  | "constant"
  | "enum"
  | "interface"
  | "module";

export interface Entity {
  id: string;
  name: string;
  type: EntityType;
  filePath: string;
  codeByteStartIndex?: number;
  codeByteEndIndex?: number;
  signature?: string;
  docstring?: string;
  dependencies?: string[];
  code?: string;
}

export interface ParseResult {
  entities: Entity[];
  edges: Edge[];
}

export type EdgeType =
  | "calls"
  | "imports"
  | "inherits"
  | "implements"
  | "references";

export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
}

export interface LanguageExtractor {
  extensions: string[];

  extract(code: string, filePath: string): ParseResult;
}