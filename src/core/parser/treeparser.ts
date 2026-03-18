// src/core/parser.ts
import Parser from "tree-sitter";

export class ASTParser {
  private parser: Parser;

  constructor(language: Parser.Language) {
    this.parser = new Parser();
    this.parser.setLanguage(language);
  }

  parse(code: string) {
    return this.parser.parse(code);
  }
}