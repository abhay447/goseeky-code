// src/core/parser.ts
import Parser = require("tree-sitter");

export type Language = {
  name: string;
  version: number;
};

export class ASTParser {
  private parser: Parser;

  constructor(language: Language) {
    this.parser = new Parser();
    this.parser.setLanguage(language);
  }

  parse(code: string) {
    return this.parser.parse(code);
  }
}