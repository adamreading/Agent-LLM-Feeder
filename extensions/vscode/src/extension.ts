import * as path from 'path';
import * as vscode from 'vscode';

interface AgentStatus {
  status: string;
  workspaceRoot: string;
  capabilities: string[];
}

interface AgentReply {
  content: string;
  routedVia?: {
    platform: string;
    model: string;
    displayName: string;
  };
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  meta?: string;
}

let chatPanel: vscode.WebviewPanel | undefined;
const chatHistory: ChatMessage[] = [];

function getConfig() {
  const config = vscode.workspace.getConfiguration('llmChatbotAgent');
  return {
    serverUrl: config.get<string>('serverUrl', 'http://localhost:3001').replace(/\/$/, ''),
    language: config.get<'en' | 'fr' | 'es'>('language', 'en'),
  };
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}

async function apiFetch<T>(pathName: string, init?: RequestInit): Promise<T> {
  const { serverUrl } = getConfig();
  const response = await fetch(`${serverUrl}${pathName}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(body.error?.message ?? `HTTP ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function getWorkspaceRelativePath(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return undefined;
  return path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/');
}

function getActiveRelativePath(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  return getWorkspaceRelativePath(editor.document.uri);
}

function getSelectedText(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return undefined;
  return editor.document.getText(editor.selection);
}

function showMarkdown(title: string, reply: AgentReply) {
  const panel = vscode.window.createWebviewPanel(
    'llmChatbotAgent.response',
    title,
    vscode.ViewColumn.Beside,
    { enableScripts: false },
  );
  const routedVia = reply.routedVia
    ? `<p class="meta">Routed via ${escapeHtml(reply.routedVia.platform)}/${escapeHtml(reply.routedVia.model)}</p>`
    : '';
  panel.webview.html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px; line-height: 1.5; }
    pre { white-space: pre-wrap; background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 6px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
  </style>
</head>
<body>
  ${routedVia}
  <pre>${escapeHtml(reply.content)}</pre>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function askAgent(message: string, paths: string[] = []) {
  const { language } = getConfig();
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'LLM Chatbot Agent is thinking...',
      cancellable: false,
    },
    () => apiFetch<AgentReply>('/api/agent/chat', {
      method: 'POST',
      body: JSON.stringify({ message, paths, language }),
    }),
  );
}

async function askAgentSilent(message: string, paths: string[] = []) {
  const { language } = getConfig();
  return apiFetch<AgentReply>('/api/agent/chat', {
    method: 'POST',
    body: JSON.stringify({ message, paths, language }),
  });
}

async function checkStatus() {
  const status = await apiFetch<AgentStatus>('/api/agent/status');
  vscode.window.showInformationMessage(
    `LLM Chatbot Agent: ${status.status} (${status.workspaceRoot})`,
  );
}

async function askCommand() {
  const activePath = getActiveRelativePath();
  const includeFile = activePath
    ? await vscode.window.showQuickPick(['Yes', 'No'], {
      title: `Include current file as context? (${activePath})`,
    })
    : 'No';
  const prompt = await vscode.window.showInputBox({
    title: 'Ask LLM Chatbot Agent',
    prompt: 'Describe the coding task',
    ignoreFocusOut: true,
  });
  if (!prompt) return;
  const reply = await askAgent(prompt, includeFile === 'Yes' && activePath ? [activePath] : []);
  showMarkdown('LLM Chatbot Agent', reply);
}

async function explainSelectionCommand() {
  const selectedText = getSelectedText();
  if (!selectedText) {
    vscode.window.showWarningMessage('Select code first.');
    return;
  }
  const activePath = getActiveRelativePath();
  const prompt = [
    'Explain this code selection and point out potential issues or improvements.',
    activePath ? `File: ${activePath}` : '',
    'Selection:',
    selectedText,
  ].filter(Boolean).join('\n\n');
  const reply = await askAgent(prompt, activePath ? [activePath] : []);
  showMarkdown('Explain Selection', reply);
}

async function reviewFileCommand() {
  const activePath = getActiveRelativePath();
  if (!activePath) {
    vscode.window.showWarningMessage('Open a workspace file first.');
    return;
  }
  const prompt = [
    'Review this file as a senior engineer.',
    'Prioritize bugs, correctness risks, security issues, and missing tests.',
    'Return concise findings with file references.',
  ].join('\n');
  const reply = await askAgent(prompt, [activePath]);
  showMarkdown(`Review ${activePath}`, reply);
}

async function openWebApp() {
  const { serverUrl } = getConfig();
  await vscode.env.openExternal(vscode.Uri.parse(serverUrl.replace(':3001', ':5173') + '/agent'));
}

function getChatHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const initialState = JSON.stringify({ messages: chatHistory });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    :root {
      color-scheme: light dark;
    }
    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
    }
    .app {
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100vh;
    }
    header {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 10px 12px;
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
    }
    header h1 {
      font-size: 13px;
      margin: 0;
      font-weight: 600;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    .messages {
      overflow-y: auto;
      padding: 14px 12px;
    }
    .message {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 10px;
      margin: 0 0 10px;
      white-space: pre-wrap;
      line-height: 1.45;
    }
    .message.user {
      background: var(--vscode-input-background);
    }
    .message.assistant {
      background: var(--vscode-editor-inactiveSelectionBackground);
    }
    .role {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    form {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 10px;
      display: grid;
      gap: 8px;
    }
    textarea {
      width: 100%;
      min-height: 88px;
      resize: vertical;
      box-sizing: border-box;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      padding: 8px;
      font-family: var(--vscode-font-family);
    }
    .actions {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      align-items: center;
    }
    label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 4px;
      padding: 6px 10px;
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:disabled {
      opacity: .55;
      cursor: not-allowed;
    }
    .empty {
      color: var(--vscode-descriptionForeground);
      text-align: center;
      margin-top: 20vh;
    }
    .error {
      color: var(--vscode-errorForeground);
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <h1>LLM Chatbot Agent</h1>
      <div class="toolbar">
        <span id="status">Ready</span>
        <button class="secondary" id="clear" type="button">Clear</button>
      </div>
    </header>
    <main class="messages" id="messages"></main>
    <form id="form">
      <textarea id="input" placeholder="Chat with your local coding agent..."></textarea>
      <div class="actions">
        <label><input id="includeFile" type="checkbox" checked> Include active file</label>
        <button id="send" type="submit">Send</button>
      </div>
    </form>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = ${initialState};
    const messagesEl = document.getElementById('messages');
    const inputEl = document.getElementById('input');
    const includeFileEl = document.getElementById('includeFile');
    const sendEl = document.getElementById('send');
    const statusEl = document.getElementById('status');

    function escapeHtml(value) {
      return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function render() {
      if (!state.messages.length) {
        messagesEl.innerHTML = '<div class="empty">Ask a question about your codebase, a selected file, or the current task.</div>';
        return;
      }
      messagesEl.innerHTML = state.messages.map(msg => (
        '<section class="message ' + msg.role + '">' +
          '<div class="role"><span>' + escapeHtml(msg.role) + '</span><span>' + escapeHtml(msg.meta || '') + '</span></div>' +
          '<div>' + escapeHtml(msg.content) + '</div>' +
        '</section>'
      )).join('');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    document.getElementById('form').addEventListener('submit', event => {
      event.preventDefault();
      const text = inputEl.value.trim();
      if (!text) return;
      sendEl.disabled = true;
      statusEl.textContent = 'Thinking...';
      vscode.postMessage({ type: 'ask', text, includeFile: includeFileEl.checked });
      inputEl.value = '';
    });

    document.getElementById('clear').addEventListener('click', () => {
      vscode.postMessage({ type: 'clear' });
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'state') {
        state = msg.state;
        sendEl.disabled = false;
        statusEl.textContent = 'Ready';
        render();
      }
      if (msg.type === 'busy') {
        sendEl.disabled = true;
        statusEl.textContent = 'Thinking...';
      }
      if (msg.type === 'error') {
        sendEl.disabled = false;
        statusEl.textContent = 'Error';
        state.messages.push({ role: 'assistant', content: msg.message, meta: 'error' });
        render();
      }
    });

    render();
    inputEl.focus();
  </script>
</body>
</html>`;
}

function postChatState() {
  chatPanel?.webview.postMessage({ type: 'state', state: { messages: chatHistory } });
}

async function openChatCommand() {
  if (chatPanel) {
    chatPanel.reveal(vscode.ViewColumn.Beside);
    postChatState();
    return;
  }

  chatPanel = vscode.window.createWebviewPanel(
    'llmChatbotAgent.chat',
    'LLM Chatbot Agent',
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
    },
  );

  chatPanel.webview.html = getChatHtml(chatPanel.webview);
  chatPanel.onDidDispose(() => {
    chatPanel = undefined;
  });
  chatPanel.webview.onDidReceiveMessage(async message => {
    if (message.type === 'clear') {
      chatHistory.length = 0;
      postChatState();
      return;
    }
    if (message.type !== 'ask') return;
    const text = String(message.text ?? '').trim();
    if (!text) return;
    const activePath = message.includeFile ? getActiveRelativePath() : undefined;
    chatHistory.push({ role: 'user', content: text, meta: activePath ? `context: ${activePath}` : undefined });
    chatPanel?.webview.postMessage({ type: 'busy' });
    postChatState();
    try {
      const reply = await askAgentSilent(text, activePath ? [activePath] : []);
      const meta = reply.routedVia ? `${reply.routedVia.platform}/${reply.routedVia.model}` : undefined;
      chatHistory.push({ role: 'assistant', content: reply.content, meta });
      postChatState();
    } catch (error) {
      chatPanel?.webview.postMessage({ type: 'error', message: (error as Error).message });
    }
  });
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('llmChatbotAgent.openChat', () => runSafely(openChatCommand)),
    vscode.commands.registerCommand('llmChatbotAgent.checkStatus', () => runSafely(checkStatus)),
    vscode.commands.registerCommand('llmChatbotAgent.ask', () => runSafely(askCommand)),
    vscode.commands.registerCommand('llmChatbotAgent.explainSelection', () => runSafely(explainSelectionCommand)),
    vscode.commands.registerCommand('llmChatbotAgent.reviewFile', () => runSafely(reviewFileCommand)),
    vscode.commands.registerCommand('llmChatbotAgent.openWebApp', () => runSafely(openWebApp)),
  );
}

async function runSafely(fn: () => Promise<void>) {
  try {
    await fn();
  } catch (error) {
    vscode.window.showErrorMessage(`LLM Chatbot Agent: ${(error as Error).message}`);
  }
}

export function deactivate() {}
