import Parser from "tree-sitter";
import Python from "tree-sitter-python";
import crypto from "crypto";
import { ASTParser, Language } from "../../treeparser";
import { Entity, ParseResult, Edge } from "../../types";
import {extractCodeSnippet} from "../../utils";

export class PythonExtractor {
    extensions = [".py"];

    extract(code: string, filePath: string): ParseResult {
        const parser = new ASTParser(Python as unknown as Language);
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
            // CLASS
            // =========================
            if (node.type === "class_definition") {
                const nameNode = node.childForFieldName("name");

                if (nameNode) {
                    const className = nameNode.text;

                    entities.push({
                        id: hash(filePath + className),
                        name: className,
                        type: "class",
                        filePath,
                        startIndex: node.startIndex,
                        endIndex: node.endIndex,
                        code : extractCodeSnippet(code,node.startIndex,node.endIndex)
                    });

                    node.children.forEach((child: any) =>
                        walk(child, className, currentFunction)
                    );
                    return;
                }
            }

            // =========================
            // FUNCTION / METHOD
            // =========================
            if (node.type === "function_definition") {
                const nameNode = node.childForFieldName("name");

                if (nameNode) {
                    const name = nameNode.text;

                    const fullName = currentClass
                        ? `${currentClass}.${name}`
                        : name;

                    entities.push({
                        id: hash(filePath + fullName),
                        name: fullName,
                        type: currentClass ? "method" : "function",
                        filePath,
                        startIndex: node.startIndex,
                        endIndex: node.endIndex,
                        code : extractCodeSnippet(code,node.startIndex,node.endIndex)
                    });

                    node.children.forEach((child: any) =>
                        walk(child, currentClass, fullName)
                    );
                    return;
                }
            }

            // =========================
            // CONSTANTS (FIXED)
            // =========================
            if (node.type === "assignment") {
                const leftNode = node.children[0];
                const rightNode = node.children[node.children.length - 1];

                if (leftNode?.type === "identifier") {
                    const name = leftNode.text;

                    const isConstant =
                        name === name.toUpperCase() ||
                        ["string", "integer", "float", "true", "false"].includes(
                            rightNode?.type
                        );

                    if (isConstant) {
                        entities.push({
                            id: hash(filePath + name),
                            name,
                            type: "constant",
                            filePath,
                        startIndex: node.startIndex,
                        endIndex: node.endIndex,
                        code : extractCodeSnippet(code,node.startIndex,node.endIndex)
                        });
                    }
                }
            }

            // =========================
            // CALLS (🔥 EDGES)
            // =========================
            if (node.type === "call") {
                const fnNode = node.childForFieldName("function");

                let calledName = "";

                if (fnNode?.type === "identifier") {
                    calledName = fnNode.text;
                }

                if (fnNode?.type === "attribute") {
                    const attr = fnNode.childForFieldName("attribute");
                    if (attr) calledName = attr.text;
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