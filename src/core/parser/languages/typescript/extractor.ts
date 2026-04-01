import Parser from "tree-sitter";
import TypeScript = require("tree-sitter-typescript");
import crypto from "crypto";
import { ASTParser, Language } from "../../treeparser";
import { Entity, ParseResult, Edge } from "../../types";
import { extractCodeSnippet } from "../../utils";

const { typescript, tsx } = TypeScript;

export class TypeScriptExtractor {
    extensions = [".ts"];

    extract(code: string, filePath: string): ParseResult {
        const parser = new ASTParser(typescript as unknown as Language);
        const tree = parser.parse(code);

        const entities: Entity[] = [];
        const edges: Edge[] = [];
        const edgeSet = new Set<string>();

        function walk(
            node: any,
            currentClass?: string,
            currentFunction?: string
        ) {

            // =========================
            // EXPORT WRAPPER FIX 🔥
            // =========================
            if (node.type === "export_statement") {
                const decl = node.childForFieldName("declaration");

                if (decl) {
                    walk(decl, currentClass, currentFunction);
                    return;
                }
            }
            // =========================
            // CLASS
            // =========================
            if (node.type === "class_declaration") {
                const nameNode = node.childForFieldName("name");

                if (nameNode) {
                    const className = nameNode.text;

                    entities.push({
                        id: hash(filePath + className),
                        name: className,
                        type: "class",
                        filePath,
                        codeByteStartIndex: node.startIndex,
                        codeByteEndIndex: node.endIndex,
                        code: extractCodeSnippet(code, node.startIndex, node.endIndex)
                    });

                    node.children.forEach((child: any) =>
                        walk(child, className, currentFunction)
                    );
                    return;
                }
            }

            // =========================
            // METHOD
            // =========================
            if (node.type === "method_definition") {
                const nameNode = node.childForFieldName("name");

                if (nameNode) {
                    const methodName = nameNode.text;
                    const fullName = currentClass
                        ? `${currentClass}.${methodName}`
                        : methodName;

                    entities.push({
                        id: hash(filePath + fullName),
                        name: fullName,
                        type: "method",
                        filePath,
                        codeByteStartIndex: node.startIndex,
                        codeByteEndIndex: node.endIndex,
                        code: extractCodeSnippet(code, node.startIndex, node.endIndex)
                    });

                    node.children.forEach((child: any) =>
                        walk(child, currentClass, fullName)
                    );
                    return;
                }
            }

            // =========================
            // FUNCTION
            // =========================
            if (node.type === "function_declaration") {
                const nameNode = node.childForFieldName("name");

                if (nameNode) {
                    const fnName = nameNode.text;

                    entities.push({
                        id: hash(filePath + fnName),
                        name: fnName,
                        type: "function",
                        filePath,
                        codeByteStartIndex: node.startIndex,
                        codeByteEndIndex: node.endIndex,
                        code: extractCodeSnippet(code, node.startIndex, node.endIndex)
                    });

                    node.children.forEach((child: any) =>
                        walk(child, currentClass, fnName)
                    );
                    return;
                }
            }

            // =========================
            // VARIABLE (arrow + constant)
            // =========================
            if (node.type === "variable_declarator") {
                const nameNode = node.childForFieldName("name");
                const valueNode = node.childForFieldName("value");

                if (nameNode && nameNode.type === "identifier") {
                    const name = nameNode.text;

                    // Arrow function
                    if (valueNode?.type === "arrow_function") {
                        const fullName = currentClass
                            ? `${currentClass}.${name}`
                            : name;

                        entities.push({
                            id: hash(filePath + fullName),
                            name: fullName,
                            type: "function",
                            filePath,
                            codeByteStartIndex: node.startIndex,
                            codeByteEndIndex: node.endIndex,
                            code: extractCodeSnippet(code, node.startIndex, node.endIndex)
                        });

                        node.children.forEach((child: any) =>
                            walk(child, currentClass, fullName)
                        );
                        return;
                    }

                    // Constants
                    const isPrimitive =
                        ["string", "number", "true", "false"].includes(valueNode?.type);

                    const isConstant =
                        name === name.toUpperCase() || isPrimitive;

                    if (isConstant) {
                        entities.push({
                            id: hash(filePath + name),
                            name,
                            type: "constant",
                            filePath,
                            codeByteStartIndex: node.startIndex,
                            codeByteEndIndex: node.endIndex,
                            code: extractCodeSnippet(code, node.startIndex, node.endIndex)
                        });
                    }
                }
            }

            // =========================
            // CALL EXPRESSIONS (🔥 EDGES)
            // =========================
            if (node.type === "call_expression") {
                const fnNode = node.childForFieldName("function");

                let calledName = "";

                if (fnNode?.type === "identifier") {
                    calledName = fnNode.text;
                }

                if (fnNode?.type === "member_expression") {
                    const prop = fnNode.childForFieldName("property");
                    if (prop) calledName = prop.text;
                }

                if (calledName && currentFunction) {
                    const key = `${currentFunction}|${calledName}|calls}`;

                    if (!edgeSet.has(key)) {
                        edgeSet.add(key);
                        edges.push({
                            from: currentFunction,
                            to: calledName,
                            type: "calls",
                        });
                    }
                }
            }

            node.children.forEach((child: any) =>
                walk(child, currentClass, currentFunction)
            );
        }

        walk(tree.rootNode);

        return { entities, edges };
    }
}

function hash(input: string) {
    return crypto.createHash("md5").update(input).digest("hex");
}