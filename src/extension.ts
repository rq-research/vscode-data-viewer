import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';

const COMMAND_ID = 'duckdb-viewer.viewFile';
const VIEW_TYPE = 'duckdb-viewer.dataViewer';

export function activate(context: vscode.ExtensionContext) {
  // Register the custom editor provider for auto-opening files
  const provider = new DuckDBEditorProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    })
  );

  // Keep the command for right-click "Open with DuckDB" option
  const disposable = vscode.commands.registerCommand(COMMAND_ID, async (uri: vscode.Uri) => {
    if (!uri) {
      vscode.window.showWarningMessage('Please right-click a file from the explorer to use this command.');
      return;
    }
    // Open using the custom editor
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  });

  context.subscriptions.push(disposable);
}

class DuckDBEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private readonly context: vscode.ExtensionContext) { }

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken
  ): Promise<vscode.CustomDocument> {
    return {
      uri,
      dispose: () => { },
    };
  }

  async resolveCustomEditor(
    document: vscode.CustomDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken
  ): Promise<void> {
    const uri = document.uri;
    const fileName = path.basename(uri.fsPath);

    webviewPanel.title = `DuckDB: ${fileName}`;
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };

    let pendingFile: { uri: vscode.Uri; fileName: string } | null = { uri, fileName };
    let duckdbReady = false;

    webviewPanel.webview.html = await getWebviewHtml(this.context, webviewPanel.webview);

    const deliverPendingFile = async () => {
      if (!duckdbReady || !pendingFile) {
        return;
      }

      const { uri: fileUri, fileName: pendingFileName } = pendingFile;

      try {
        const fileBytes = await vscode.workspace.fs.readFile(fileUri);
        webviewPanel.webview.postMessage({
          command: 'loadFile',
          fileName: pendingFileName,
          fileData: fileBytes,
        });
      } catch (e) {
        const message = e instanceof Error ? `Failed to read file: ${e.message}` : String(e);
        webviewPanel.webview.postMessage({
          command: 'error',
          message,
        });
        vscode.window.showErrorMessage(message);
      } finally {
        pendingFile = null;
      }
    };

    webviewPanel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === 'ready') {
          try {
            const bundles = await prepareDuckDBBundles(this.context, webviewPanel.webview);
            webviewPanel.webview.postMessage({ command: 'init', bundles });
          } catch (e) {
            webviewPanel.webview.postMessage({
              command: 'error',
              message: e instanceof Error ? e.message : String(e),
            });
          }
          return;
        }

        if (message.command === 'duckdb-ready') {
          duckdbReady = true;
          await deliverPendingFile();

          // Send the list of all compatible files in the workspace
          try {
            const compatibleFiles = await discoverCompatibleFiles();
            webviewPanel.webview.postMessage({
              command: 'fileList',
              files: compatibleFiles,
            });
          } catch (e) {
            console.error('Failed to discover files:', e);
          }
          return;
        }

        if (message.command === 'export-data') {
          await handleExportMessage(message, webviewPanel);
          return;
        }

        if (message.command === 'loadFileFromList') {
          const fileUri = vscode.Uri.file(message.filePath);
          const fileName = path.basename(message.filePath);
          pendingFile = { uri: fileUri, fileName };
          await deliverPendingFile();
          return;
        }
      },
      undefined,
      this.context.subscriptions
    );
  }
}

async function handleExportMessage(message: any, panel: vscode.WebviewPanel) {
  try {
    const buffer = message.buffer as ArrayBuffer | number[] | Uint8Array | undefined;
    if (!buffer) {
      throw new Error('No export data supplied.');
    }
    const bytes = buffer instanceof Uint8Array
      ? buffer
      : buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer);
    const fileName = typeof message.fileName === 'string' ? message.fileName : 'duckdb_export';
    const format = typeof message.format === 'string' ? message.format.toLowerCase() : 'file';
    const filters = getExportFilters(format);
    const defaultUri = getDefaultExportUri(fileName);
    const targetUri = await vscode.window.showSaveDialog({
      title: 'Save DuckDB export',
      defaultUri,
      filters,
      saveLabel: 'Save',
    });
    if (!targetUri) {
      return;
    }
    await vscode.workspace.fs.writeFile(targetUri, bytes);

    const choice = await vscode.window.showInformationMessage(
      `DuckDB export saved to ${targetUri.fsPath}`,
      'Open File',
      'Open in DuckDB Viewer'
    );

    if (choice === 'Open File') {
      await vscode.commands.executeCommand('vscode.open', targetUri);
    } else if (choice === 'Open in DuckDB Viewer') {
      await vscode.commands.executeCommand(COMMAND_ID, targetUri);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`DuckDB export failed: ${errMsg}`);
  }
}

function getDefaultExportUri(fileName: string): vscode.Uri | undefined {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    return vscode.Uri.joinPath(workspaceFolder.uri, fileName);
  }
  try {
    const homedir = os.homedir();
    if (homedir) {
      return vscode.Uri.file(path.join(homedir, fileName));
    }
  } catch {
    // ignore
  }
  return undefined;
}

function getExportFilters(format: string): Record<string, string[]> | undefined {
  if (format === 'csv') {
    return { CSV: ['csv'] };
  }
  if (format === 'parquet') {
    return { Parquet: ['parquet'] };
  }
  if (format === 'arrow') {
    return { Arrow: ['arrow'] };
  }
  return undefined;
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

// Discover all compatible files in the workspace
async function discoverCompatibleFiles(): Promise<Array<{ path: string; relativePath: string; type: string }>> {
  const supportedExtensions = ['csv', 'parquet', 'parq', 'arrow', 'ipc'];
  const files: Array<{ path: string; relativePath: string; type: string }> = [];

  for (const ext of supportedExtensions) {
    const foundFiles = await vscode.workspace.findFiles(
      `**/*.${ext}`,
      '**/node_modules/**',
      1000 // limit to 1000 files per extension
    );

    for (const fileUri of foundFiles) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
      const relativePath = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath)
        : path.basename(fileUri.fsPath);

      files.push({
        path: fileUri.fsPath,
        relativePath: relativePath,
        type: ext === 'parq' ? 'parquet' : ext,
      });
    }
  }

  // Sort files by relative path
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return files;
}

export function deactivate() { }
