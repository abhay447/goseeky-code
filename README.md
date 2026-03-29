# VS Code AI Extension

This VS Code extension uses a standard AI architecture.

## Architecture Overview

The main entry point `extension.ts` activates on load, setting up the webview UI and commands.

### UI Components
The UI is built with HTML/CSS/JS in `webview/`, featuring:
- Chat interface
- Code editor

### Agentic Loop
The agentic loop processes user messages via the webview, using:
- **LangChain** for orchestration
- **Vector database** for code context
- **Tree-sitter** for parsing
- **AI provider** generates responses that flow back to the UI

## Key Directories

- `src/extension.ts` - Extension activation
- `src/webview/` - UI components
- `src/agent/` - AI logic
- `src/database/` - Embeddings
- `src/parsers/` - Code analysis
- `src/config/` - Settings

## Features

The extension offers:
- Code explanation
- Q&A capabilities
- AI-assisted coding