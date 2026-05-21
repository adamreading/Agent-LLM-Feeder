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
- `LLM Chatbot Agent: Open Chat With Current File`
- `LLM Chatbot Agent: Check Server Status`
- `LLM Chatbot Agent: Ask Agent`
- `LLM Chatbot Agent: Explain Selection`
- `LLM Chatbot Agent: Review Current File`
- `LLM Chatbot Agent: Open Web App`

Use `Open Chat` for the ChatGPT-like experience inside VS Code. The chat panel keeps a local conversation history and can include the active file as context for each message.

Use `Open Chat With Current File` when you want to discuss a specific open file such as `README.md`. The chat panel will show `Attached: <file>` so you can verify what is being sent.

When the assistant answers with a fenced code block, use `Create file from last answer` in the chat toolbar to create the suggested file without copying and pasting.

If the command does not appear after reinstalling the `.vsix`, run `Developer: Reload Window` in VS Code.

## Build

```powershell
npm.cmd install
npm.cmd run build -w llm-chatbot-agent
```

For a `.vsix` package:

```powershell
npm.cmd run package -w llm-chatbot-agent
```

Install the generated package with:

```powershell
code --install-extension extensions\vscode\llm-chatbot-agent-0.1.2.vsix --force
```
