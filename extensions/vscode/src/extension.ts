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

function getConfig() {
  const config = vscode.workspace.getConfiguration('llmChatbotAgent');
  return {
    serverUrl: config.get<string>('serverUrl', 'http://localhost:3001').replace(/\/$/, ''),
    language: config.get<'en' | 'fr' | 'es'>('language', 'en'),
  };
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

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
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
