# LLM Chatbot Agent for VS Code

This extension connects VS Code to the local LLM Chatbot agent server.

## Requirements

Start the web app first from the repository root:

```powershell
npm.cmd run dev
```

The extension expects the local server at:

```text
http://localhost:3001
```

You can change this in VS Code settings with `llmChatbotAgent.serverUrl`.

## Commands

- `LLM Chatbot Agent: Open Chat`
- `LLM Chatbot Agent: Check Server Status`
- `LLM Chatbot Agent: Ask Agent`
- `LLM Chatbot Agent: Explain Selection`
- `LLM Chatbot Agent: Review Current File`
- `LLM Chatbot Agent: Open Web App`

Use `Open Chat` for the ChatGPT-like experience inside VS Code. The chat panel keeps a local conversation history and can include the active file as context for each message.

## Build

```powershell
npm.cmd install
npm.cmd run build -w llm-chatbot-agent
```

For a `.vsix` package:

```powershell
npm.cmd run package -w llm-chatbot-agent
```
