import * as duckdb from '@duckdb/duckdb-wasm';
import { Table, tableToIPC } from 'apache-arrow';
import { csvLoader } from './loaders/csvLoader';
import { arrowLoader } from './loaders/arrowLoader';
import { parquetLoader } from './loaders/parquetLoader';
import { DataLoader } from './loaders/types';
import { buildDefaultQuery } from './utils/sqlHelpers';

declare const acquireVsCodeApi: any;
const vscode = acquireVsCodeApi();

// Get UI elements
const status = document.getElementById('status');
const controls = document.getElementById('controls');
const resultsContainer = document.getElementById('results-container');
const sqlInput = document.getElementById('sql-input') as HTMLTextAreaElement;
const runButton = document.getElementById('run-query') as HTMLButtonElement;
const copySqlButton = document.getElementById('copy-sql') as HTMLButtonElement;
const statusWrapper = document.getElementById('status-wrapper');
const globalSearchInput = document.getElementById('global-search') as HTMLInputElement;
const rowCountLabel = document.getElementById('row-count');
const resetButton = document.getElementById('reset-query') as HTMLButtonElement | null;
const sqlErrorContainer = document.getElementById('sql-error');
const historyList = document.getElementById('history-list');
const exportButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-export-format]'));
const fileDiscoveryHeader = document.getElementById('file-discovery-header');
const fileDiscoveryArrow = document.getElementById('file-discovery-arrow');
const fileListContainer = document.getElementById('file-list-container');
const fileList = document.getElementById('file-list');
const fileDiscoveryCount = document.getElementById('file-discovery-count');
const historyButton = document.getElementById('history-button');
const historyModal = document.getElementById('history-modal');
const closeHistoryModal = document.getElementById('close-history-modal');

type SortDirection = 'asc' | 'desc' | null;

interface TableRow {
  raw: any[];
  display: string[];
}

interface TableData {
  columns: string[];
  rows: TableRow[];
}

interface QueryHistoryEntry {
  id: number;
  sql: string;
  timestamp: number;
  durationMs: number;
  rowCount: number;
  error?: string;
}

type ExportFormat = 'csv' | 'parquet' | 'arrow';

let db: duckdb.AsyncDuckDB | null = null;
let connection: duckdb.AsyncDuckDBConnection | null = null;
let duckdbInitializationPromise: Promise<void> | null = null;
let currentTableData: TableData | null = null;
let columnFilters: string[] = [];
let globalFilter = '';
let sortState: { columnIndex: number; direction: SortDirection } = { columnIndex: -1, direction: null };
let tableBodyElement: HTMLTableSectionElement | null = null;
let copyTimeoutHandle: number | null = null;
const DATA_LOADERS: DataLoader[] = [arrowLoader, parquetLoader, csvLoader];
let defaultQueryText: string | null = null;
let queryHistory: QueryHistoryEntry[] = [];
let nextHistoryId = 1;
let lastArrowResult: Table | null = null;

// --- Event Listeners (Moved to top) ---
async function runQueryWithUiFeedback(sql: string) {
  clearSqlError();
  try {
    await runQuery(sql);
  } catch (error) {
    showSqlError(error);
  }
}

// Listen for messages from the extension
window.addEventListener('message', (event: any) => {
  const message = event.data;
  if (message.command === 'init') {
    ensureDuckDBInitialized(message.bundles).catch(reportError);
  } else if (message.command === 'loadFile') {
    handleFileLoad(message.fileName, message.fileData).catch(reportError);
  } else if (message.command === 'error') {
    reportError(message.message);
  } else if (message.command === 'fileList') {
    populateFileList(message.files);
  }
});

// Listen for the "Run" button click
runButton.addEventListener('click', () => {
  runQueryWithUiFeedback(sqlInput.value);
});

// Allow Cmd/Ctrl + Enter to run the query
sqlInput.addEventListener('keydown', (event: KeyboardEvent) => {
  const isSubmitShortcut = event.key === 'Enter' && (event.metaKey || event.ctrlKey);
  if (isSubmitShortcut) {
    event.preventDefault();
    runQueryWithUiFeedback(sqlInput.value);
  }
});

// Global search box to filter visible rows
if (globalSearchInput) {
  globalSearchInput.addEventListener('input', () => {
    globalFilter = globalSearchInput.value;
    applyTableState();
  });
}

// Copy SQL to the clipboard for quick sharing
if (copySqlButton) {
  copySqlButton.addEventListener('click', async () => {
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard) {
        updateStatus('Clipboard access is not available in this environment.');
        return;
      }
      await clipboard.writeText(sqlInput.value);
      flashCopyState();
    } catch (err) {
      updateStatus('Copy to clipboard is unavailable in this context.');
      console.warn('[Webview] Clipboard copy failed', err);
    }
  });
}

if (resetButton) {
  resetButton.addEventListener('click', () => {
    if (!defaultQueryText) {
      return;
    }
    sqlInput.value = defaultQueryText;
    runQueryWithUiFeedback(defaultQueryText);
  });
}

exportButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const format = button.dataset.exportFormat as ExportFormat | undefined;
    if (format) {
      exportResult(format).catch(reportError);
    }
  });
});

// History modal controls
if (historyButton) {
  historyButton.addEventListener('click', () => {
    openHistoryModal();
  });
}

if (closeHistoryModal) {
  closeHistoryModal.addEventListener('click', () => {
    closeHistoryModalWindow();
  });
}

if (historyModal) {
  historyModal.addEventListener('click', (e) => {
    if (e.target === historyModal) {
      closeHistoryModalWindow();
    }
  });
}

renderQueryHistory();
updateResetButtonState();

// File discovery toggle
if (fileDiscoveryHeader) {
  fileDiscoveryHeader.addEventListener('click', () => {
    const isExpanded = fileListContainer?.classList.contains('expanded');
    if (isExpanded) {
      fileListContainer?.classList.remove('expanded');
      fileDiscoveryArrow?.classList.remove('expanded');
    } else {
      fileListContainer?.classList.add('expanded');
      fileDiscoveryArrow?.classList.add('expanded');
    }
  });
}
// --- Core Functions ---

function createDuckDBWorker(workerSource: string, workerUrl: string): { worker: Worker; cleanup: () => void } {
  updateStatus('Creating DuckDB worker from source...');
  const bootstrap = `
      self.window = self;
      self.document = { currentScript: { src: ${JSON.stringify(workerUrl)} } };
  `;
  const blob = new Blob([bootstrap, '\n', workerSource], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  return {
    worker: new Worker(blobUrl),
    cleanup: () => URL.revokeObjectURL(blobUrl),
  };
}

async function ensureDuckDBInitialized(bundles: duckdb.DuckDBBundles) {
  if (connection) {
    updateStatus('DuckDB ready. Waiting for file data…');
    vscode.postMessage({ command: 'duckdb-ready' });
    return;
  }

  if (!duckdbInitializationPromise) {
    duckdbInitializationPromise = bootstrapDuckDB(bundles).catch((error) => {
      duckdbInitializationPromise = null;
      throw error;
    });
  }

  await duckdbInitializationPromise;
}

async function bootstrapDuckDB(bundles: duckdb.DuckDBBundles) {
  try {
    updateStatus('Selecting DuckDB bundle...');
    const selectedBundle = await duckdb.selectBundle(bundles);

    if (!selectedBundle.mainWorker || typeof selectedBundle.mainWorker !== 'string') {
      throw new Error('Selected bundle has no worker source.');
    }
    if (!selectedBundle.mainModule) {
      throw new Error('Selected bundle has no WASM module URL.');
    }

    const workerUrl = selectedBundle.mainModule.replace('.wasm', '.worker.js');
    const { worker, cleanup } = createDuckDBWorker(selectedBundle.mainWorker, workerUrl);

    const logger = new duckdb.ConsoleLogger();
    db = new duckdb.AsyncDuckDB(logger, worker);

    updateStatus('Instantiating DuckDB...');
    await db.instantiate(selectedBundle.mainModule, selectedBundle.pthreadWorker);
    cleanup();

    updateStatus('Opening DuckDB...');
    await db.open({ path: ':memory:' });

    updateStatus('Connecting to DuckDB...');
    connection = await db.connect();

    updateStatus('Installing extensions...');
    await connection.query("INSTALL parquet; LOAD parquet;");
    await connection.query("INSTALL sqlite; LOAD sqlite;");

    updateStatus('DuckDB ready. Waiting for file data…');
    vscode.postMessage({ command: 'duckdb-ready' });

  } catch (e) {
    reportError(e);
  }
}

async function handleFileLoad(fileName: string, fileData: any) {
  if (!db || !connection) {
    throw new Error('DuckDB is not initialized.');
  }

  const fileBytes = extractFileBytes(fileData);
  if (fileBytes.length === 0) {
    throw new Error('File is empty (0 bytes).');
  }

  const loader = selectLoader(fileName);
  updateStatus(`Preparing ${loader.id.toUpperCase()} data for ${fileName}…`);
  const loadResult = await loader.load(fileName, fileBytes, {
    db,
    connection,
    updateStatus,
  });

  const defaultQuery = buildDefaultQuery(loadResult.columns, loadResult.relationIdentifier);
  sqlInput.value = defaultQuery;
  sqlInput.placeholder = `Example: ${defaultQuery}`;
  defaultQueryText = defaultQuery;
  updateResetButtonState();

  if (controls) {
    controls.style.display = 'flex';
  }
  if (resultsContainer) {
    resultsContainer.style.display = 'block';
  }

  await runQueryWithUiFeedback(defaultQuery);
}

function selectLoader(fileName: string): DataLoader {
  return DATA_LOADERS.find((loader) => loader.canLoad(fileName)) ?? csvLoader;
}

function extractFileBytes(fileData: any): Uint8Array {
  if (fileData instanceof Uint8Array) {
    return fileData;
  }
  if (fileData?.data instanceof ArrayBuffer) {
    return new Uint8Array(fileData.data);
  }
  if (Array.isArray(fileData?.data)) {
    return new Uint8Array(fileData.data);
  }
  if (fileData instanceof ArrayBuffer) {
    return new Uint8Array(fileData);
  }
  if (fileData?.buffer instanceof ArrayBuffer) {
    return new Uint8Array(fileData.buffer);
  }
  throw new Error('Unable to read file bytes from message.');
}

async function runQuery(sql: string) {
  if (!connection) {
    throw new Error('No database connection.');
  }

  const normalizedSql = sql.trim();
  if (!normalizedSql) {
    showSqlError('Enter a SQL query to run.');
    return;
  }

  runButton.disabled = true;

  const start = performance.now();
  const entryBase: QueryHistoryEntry = {
    id: nextHistoryId++,
    sql: normalizedSql,
    timestamp: Date.now(),
    durationMs: 0,
    rowCount: 0,
  };

  try {
    const result = await connection.query(normalizedSql);
    renderResults(result);
    if (statusWrapper) {
      statusWrapper.style.display = 'none';
    }
    recordQueryHistory({
      ...entryBase,
      durationMs: performance.now() - start,
      rowCount: result ? result.numRows : 0,
    });
  } catch (e) {
    recordQueryHistory({
      ...entryBase,
      durationMs: performance.now() - start,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  } finally {
    runButton.disabled = false;
  }
}

function renderResults(table: Table | null) {
  if (!resultsContainer) {
    return;
  }

  if (!table || table.numRows === 0) {
    resultsContainer.innerHTML = '<div class="empty-state">Query completed. No rows returned.</div>';
    currentTableData = null;
    tableBodyElement = null;
    updateRowCount(0, 0);
    lastArrowResult = table;
    return;
  }

  lastArrowResult = table;
  const rows: TableRow[] = [];
  const columns = table.schema.fields.map((field) => field.name);

  for (let i = 0; i < table.numRows; i++) {
    const row = table.get(i);
    if (!row) {
      continue;
    }

    const raw: any[] = [];
    const display: string[] = [];
    for (const field of table.schema.fields) {
      const value = row[field.name];
      raw.push(value);
      display.push(formatCell(value));
    }
    rows.push({ raw, display });
  }

  currentTableData = { columns, rows };
  columnFilters = columns.map(() => '');
  globalFilter = '';
  sortState = { columnIndex: -1, direction: null };
  if (globalSearchInput) {
    globalSearchInput.value = '';
  }

  buildTableSkeleton(columns);
  applyTableState();

  resultsContainer.style.display = 'block';
  resultsContainer.scrollTop = 0;
}

function buildTableSkeleton(columns: string[]) {
  if (!resultsContainer) {
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  headerRow.className = 'column-row';

  columns.forEach((column, index) => {
    const th = document.createElement('th');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'header-button';

    const label = document.createElement('span');
    label.textContent = column;
    const indicator = document.createElement('span');
    indicator.className = 'sort-indicator';

    button.append(label, indicator);
    button.addEventListener('click', () => toggleSort(index));
    th.appendChild(button);
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  const filterRow = document.createElement('tr');
  filterRow.className = 'filter-row';
  columns.forEach((column, index) => {
    const th = document.createElement('th');
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Filter';
    input.value = columnFilters[index] ?? '';
    input.setAttribute('aria-label', `Filter column ${column}`);
    input.addEventListener('input', () => {
      columnFilters[index] = input.value;
      applyTableState();
    });
    th.appendChild(input);
    filterRow.appendChild(th);
  });
  thead.appendChild(filterRow);

  const tbody = document.createElement('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);

  resultsContainer.innerHTML = '';
  resultsContainer.appendChild(table);
  tableBodyElement = tbody;
  syncColumnHeaderHeight(headerRow);
}

function applyTableState() {
  if (!currentTableData || !tableBodyElement) {
    return;
  }
  const tbody = tableBodyElement;

  const normalizedGlobal = globalFilter.trim().toLowerCase();
  const normalizedFilters = columnFilters.map((value) => value.trim().toLowerCase());

  let visibleRows = currentTableData.rows.filter((row) => {
    if (normalizedGlobal) {
      const hasMatch = row.display.some((cell) => cell.toLowerCase().includes(normalizedGlobal));
      if (!hasMatch) {
        return false;
      }
    }
    return normalizedFilters.every((filter, idx) => {
      if (!filter) {
        return true;
      }
      return (row.display[idx] ?? '').toLowerCase().includes(filter);
    });
  });

  if (sortState.direction && sortState.columnIndex >= 0) {
    const directionMultiplier = sortState.direction === 'asc' ? 1 : -1;
    const sortIndex = sortState.columnIndex;
    visibleRows = [...visibleRows].sort((a, b) => {
      const comparison = compareValues(
        a.raw[sortIndex],
        b.raw[sortIndex],
        a.display[sortIndex],
        b.display[sortIndex]
      );
      return comparison * directionMultiplier;
    });
  } else {
    visibleRows = [...visibleRows];
  }

  tbody.innerHTML = '';

  if (visibleRows.length === 0) {
    const emptyRow = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = currentTableData.columns.length || 1;
    cell.textContent = 'No rows match the current filters.';
    cell.className = 'empty-row';
    emptyRow.appendChild(cell);
    tbody.appendChild(emptyRow);
  } else {
    visibleRows.forEach((row) => {
      const tr = document.createElement('tr');
      row.display.forEach((value) => {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  updateRowCount(visibleRows.length, currentTableData.rows.length);
  refreshSortIndicators();
}

function syncColumnHeaderHeight(headerRow: HTMLTableRowElement) {
  window.requestAnimationFrame(() => {
    const height = headerRow.getBoundingClientRect().height;
    if (height > 0) {
      document.documentElement.style.setProperty('--column-header-height', `${height}px`);
    }
  });
}

function toggleSort(columnIndex: number) {
  if (sortState.columnIndex === columnIndex) {
    if (sortState.direction === 'asc') {
      sortState.direction = 'desc';
    } else if (sortState.direction === 'desc') {
      sortState = { columnIndex: -1, direction: null };
    } else {
      sortState.direction = 'asc';
    }
  } else {
    sortState = { columnIndex, direction: 'asc' };
  }
  applyTableState();
}

function refreshSortIndicators() {
  if (!resultsContainer) {
    return;
  }

  const headerButtons = Array.from(resultsContainer.querySelectorAll<HTMLButtonElement>('.header-button'));
  headerButtons.forEach((button, index) => {
    if (sortState.columnIndex === index && sortState.direction) {
      button.dataset.sort = sortState.direction;
    } else {
      delete button.dataset.sort;
    }
  });
}

function updateRowCount(visible: number, total: number) {
  if (!rowCountLabel) {
    return;
  }
  if (total === 0) {
    rowCountLabel.textContent = 'No rows to display';
    return;
  }
  const visibleLabel = visible.toLocaleString();
  const totalLabel = total.toLocaleString();
  rowCountLabel.textContent = visible === total
    ? `${visibleLabel} rows`
    : `${visibleLabel} of ${totalLabel} rows`;
}

function compareValues(a: any, b: any, aDisplay: string, bDisplay: string): number {
  if (a === b) {
    return 0;
  }

  const aIsNumber = typeof a === 'number' && Number.isFinite(a);
  const bIsNumber = typeof b === 'number' && Number.isFinite(b);
  if (aIsNumber && bIsNumber) {
    return a < b ? -1 : 1;
  }

  const aIsDate = a instanceof Date;
  const bIsDate = b instanceof Date;
  if (aIsDate && bIsDate) {
    return a.getTime() - b.getTime();
  }

  const textA = (aDisplay ?? '').toLowerCase();
  const textB = (bDisplay ?? '').toLowerCase();
  return textA.localeCompare(textB, undefined, { numeric: true, sensitivity: 'base' });
}

function formatCell(value: any): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toString() : '';
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function recordQueryHistory(entry: QueryHistoryEntry) {
  queryHistory = [entry, ...queryHistory].slice(0, 25);
  renderQueryHistory();
}

function renderQueryHistory() {
  if (!historyList) {
    return;
  }
  if (queryHistory.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No queries executed yet. Run a query to see it here.</div>';
    return;
  }

  const items = queryHistory
    .map((entry) => {
      const metaParts = [
        `${entry.rowCount.toLocaleString()} row${entry.rowCount === 1 ? '' : 's'}`,
        `${Math.max(1, Math.round(entry.durationMs)).toLocaleString()} ms`,
        new Date(entry.timestamp).toLocaleTimeString(),
      ];
      const meta = metaParts.join(' • ');
      const classes = ['history-item'];
      if (entry.error) {
        classes.push('error');
      }
      return `
        <article class="${classes.join(' ')}" data-history-id="${entry.id}">
          <div class="history-body">
            <div class="history-sql">${escapeHtml(entry.sql)}</div>
            <div class="history-meta">${entry.error ? escapeHtml(entry.error) + ' • ' : ''}${meta}</div>
          </div>
        </article>
      `;
    })
    .join('');

  historyList.innerHTML = items;
  historyList.querySelectorAll<HTMLElement>('.history-item').forEach((item) => {
    item.addEventListener('click', () => {
      const id = Number(item.dataset.historyId);
      const entry = queryHistory.find((e) => e.id === id);
      if (entry) {
        sqlInput.value = entry.sql;
        closeHistoryModalWindow();
        runQueryWithUiFeedback(entry.sql);
      }
    });
  });
}

function openHistoryModal() {
  if (historyModal) {
    historyModal.classList.add('visible');
  }
}

function closeHistoryModalWindow() {
  if (historyModal) {
    historyModal.classList.remove('visible');
  }
}

function updateResetButtonState() {
  if (resetButton) {
    resetButton.disabled = !defaultQueryText;
  }
}

async function exportResult(format: ExportFormat) {
  if (!connection || !db) {
    throw new Error('DuckDB is not ready for export.');
  }
  const baseName = 'duckdb_result';
  const normalizedQuery = sqlInput.value.trim();
  if (!normalizedQuery) {
    updateStatus('Write a SQL query to export first.');
    return;
  }

  if (format === 'arrow') {
    if (!lastArrowResult) {
      await runQuery(normalizedQuery);
    }
    if (!lastArrowResult) {
      updateStatus('Run the query before exporting to Arrow.');
      return;
    }
    const arrowBuffer = asSerializableBuffer(tableToIPC(lastArrowResult, 'file'));
    await requestFileSave(`${baseName}.arrow`, arrowBuffer, format);
    return;
  }

  const exportPath = `memory://duckdb-viewer/${Date.now()}.${format}`;
  const wrappedQuery = normalizeSqlForEmbedding(normalizedQuery);
  const copyStatement = format === 'csv'
    ? `COPY (${wrappedQuery}) TO '${exportPath}' (FORMAT CSV, HEADER true);`
    : `COPY (${wrappedQuery}) TO '${exportPath}' (FORMAT PARQUET);`;

  await connection.query(copyStatement);
  const buffer = await db.copyFileToBuffer(exportPath);
  await db.dropFile(exportPath);

  const extension = format === 'csv' ? 'csv' : 'parquet';
  await requestFileSave(`${baseName}.${extension}`, asSerializableBuffer(buffer), format);
}

async function requestFileSave(fileName: string, buffer: ArrayBuffer, format: ExportFormat) {
  const serializable = Array.from(new Uint8Array(buffer));
  vscode.postMessage({
    command: 'export-data',
    fileName,
    format,
    buffer: serializable,
  });
}

function normalizeSqlForEmbedding(sql: string): string {
  return sql.replace(/;\s*$/g, '').trim();
}

function escapeHtml(value: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, (char) => map[char]);
}

function asSerializableBuffer(view: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy.buffer;
}

function showSqlError(error: any) {
  if (!sqlErrorContainer) {
    return;
  }
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String(error);
  sqlErrorContainer.textContent = `SQL error: ${message}`;
  sqlErrorContainer.classList.add('visible');
}

function clearSqlError() {
  if (!sqlErrorContainer) {
    return;
  }
  sqlErrorContainer.textContent = '';
  sqlErrorContainer.classList.remove('visible');
}

// ---
// Helpers
// ---
function flashCopyState() {
  if (!copySqlButton) {
    return;
  }
  const originalLabel = copySqlButton.textContent ?? 'Copy SQL';
  copySqlButton.textContent = 'Copied!';
  copySqlButton.disabled = true;
  if (copyTimeoutHandle) {
    window.clearTimeout(copyTimeoutHandle);
  }
  copyTimeoutHandle = window.setTimeout(() => {
    copySqlButton!.textContent = originalLabel;
    copySqlButton!.disabled = false;
  }, 1200);
}

function updateStatus(message: string) {
  // Always make the status bar visible when updating
  if (statusWrapper) {
    statusWrapper.style.display = 'block';
  }
  if (status) {
    status.textContent = message;
    status.classList.remove('error'); // Remove error style if it was there
  }
}
function reportError(e: any) {
  const message = e instanceof Error ? e.message : String(e);

  // Always make the status bar visible for errors
  if (statusWrapper) {
    statusWrapper.style.display = 'block';
  }
  if (status) {
    status.textContent = `Error: ${message}`;
    status.classList.add('error'); // Add a red error style
  }
  console.error(`[Error] ${message}`, e);
}

// Populate the file list in the discovery panel
function populateFileList(files: Array<{ path: string; relativePath: string; type: string }>) {
  if (!fileList || !fileDiscoveryCount) {
    return;
  }

  if (files.length === 0) {
    fileList.innerHTML = '<div class="file-list-empty">No compatible files found in workspace</div>';
    fileDiscoveryCount.textContent = '';
    return;
  }

  fileDiscoveryCount.textContent = `(${files.length})`;

  const listHtml = files.map(file => {
    const escapedPath = file.path.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const escapedRelativePath = file.relativePath.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `
      <div class="file-item" data-file-path="${escapedPath}" title="${escapedRelativePath}">
        <span class="file-type-badge">${file.type}</span>
        <span class="file-path">${escapedRelativePath}</span>
      </div>
    `;
  }).join('');

  fileList.innerHTML = listHtml;

  // Add click handlers to all file items
  const fileItems = fileList.querySelectorAll('.file-item');
  fileItems.forEach(item => {
    item.addEventListener('click', () => {
      const filePath = item.getAttribute('data-file-path');
      if (filePath) {
        vscode.postMessage({
          command: 'loadFileFromList',
          filePath: filePath
        });
      }
    });
  });
}

// Send the 'ready' signal to the extension to start the handshake
updateStatus('Webview loaded. Sending "ready" to extension.');
vscode.postMessage({ command: 'ready' });
