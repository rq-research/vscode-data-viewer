import * as vscode from 'vscode';
import * as path from 'path';

// The new command ID from package.json
const COMMAND_ID = 'duckdb-viewer.viewFile';

export function activate(context: vscode.ExtensionContext) {
  let currentPanel: vscode.WebviewPanel | undefined;
  let duckdbReady = false;
  let pendingFile: { uri: vscode.Uri; fileName: string } | null = null;

  async function ensurePanel(): Promise<vscode.WebviewPanel> {
    if (currentPanel) {
      return currentPanel;
    }

    duckdbReady = false;

    const panel = vscode.window.createWebviewPanel(
      'duckdbDataViewer',
      'DuckDB',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')]
      }
    );

    panel.webview.html = await getWebviewHtml(context, panel.webview);

    panel.onDidDispose(
      () => {
        currentPanel = undefined;
        duckdbReady = false;
        pendingFile = null;
      },
      undefined,
      context.subscriptions
    );

    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === 'ready') {
          try {
            const bundles = await prepareDuckDBBundles(context, panel.webview);
            panel.webview.postMessage({ command: 'init', bundles });
          } catch (e) {
            panel.webview.postMessage({
              command: 'error',
              message: e instanceof Error ? e.message : String(e)
            });
          }
        }

        if (message.command === 'duckdb-ready') {
          duckdbReady = true;
          await deliverPendingFile();
        }
      },
      undefined,
      context.subscriptions
    );

    currentPanel = panel;
    return panel;
  }

  async function deliverPendingFile() {
    if (!currentPanel || !duckdbReady || !pendingFile) {
      return;
    }

    const targetPanel = currentPanel;
    const { uri, fileName } = pendingFile;

    try {
      const fileBytes = await vscode.workspace.fs.readFile(uri);
      targetPanel.webview.postMessage({
        command: 'loadFile',
        fileName,
        fileData: fileBytes
      });
    } catch (e) {
      const message = e instanceof Error ? `Failed to read file: ${e.message}` : String(e);
      targetPanel.webview.postMessage({
        command: 'error',
        message
      });
      vscode.window.showErrorMessage(message);
    } finally {
      pendingFile = null;
    }
  }

  let disposable = vscode.commands.registerCommand(COMMAND_ID, async (uri: vscode.Uri) => {
    if (!uri) {
      vscode.window.showWarningMessage('Please right-click a file from the explorer to use this command.');
      return;
    }

    const fileName = path.basename(uri.fsPath);
    pendingFile = { uri, fileName };

    const panel = await ensurePanel();
    panel.title = `DuckDB: ${fileName}`;
    panel.reveal(vscode.ViewColumn.One);

    if (duckdbReady) {
      await deliverPendingFile();
    }
  });

  context.subscriptions.push(disposable);
}

// Helper to read a worker file from dist into a string
async function readWorkerSource(context: vscode.ExtensionContext, fileName: string): Promise<string> {
  const workerUri = vscode.Uri.joinPath(context.extensionUri, 'dist', fileName);
  const workerBytes = await vscode.workspace.fs.readFile(workerUri);
  return new TextDecoder().decode(workerBytes);
}

// Prepare all asset paths and worker source code
async function prepareDuckDBBundles(context: vscode.ExtensionContext, webview: vscode.Webview) {
  const mvpWasmUrl = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'duckdb-mvp.wasm')).toString();
  const ehWasmUrl = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'duckdb-eh.wasm')).toString();
  const mvpWorkerSource = await readWorkerSource(context, 'duckdb-browser-mvp.worker.js');
  const ehWorkerSource = await readWorkerSource(context, 'duckdb-browser-eh.worker.js');

  return {
    mvp: {
      mainModule: mvpWasmUrl,
      mainWorker: mvpWorkerSource,
    },
    eh: {
      mainModule: ehWasmUrl,
      mainWorker: ehWorkerSource,
    },
  };
}

// Reads the HTML template from disk
async function getWebviewHtml(context: vscode.ExtensionContext, webview: vscode.Webview): Promise<string> {
  const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'src', 'webview.html');
  const template = await vscode.workspace.fs.readFile(htmlPath);
  const nonce = generateNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.js'));
  const toolkitUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist', 'toolkit.js'));

  return new TextDecoder().decode(template)
    .replace(/{{nonce}}/g, nonce)
    .replace(/{{csp_source}}/g, webview.cspSource)
    .replace(/{{webview_script_uri}}/g, scriptUri.toString())
    .replace(/{{toolkit_uri}}/g, toolkitUri.toString());
}

function generateNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function deactivate() {}
