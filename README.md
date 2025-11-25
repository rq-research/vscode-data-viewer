# Data Viewer

A VS Code extension for viewing and querying CSV, Parquet, and Arrow files with SQL using DuckDB.

## Features

- **Auto-open** - CSV, Parquet, and Arrow files open directly in an interactive table viewer
- **SQL queries** - Write SQL to filter, transform, and analyze your data
- **Fast** - Powered by DuckDB WASM for in-browser processing
- **Export** - Save query results as CSV, Parquet, or Arrow
- **Query history** - Track and re-run previous queries

## Supported File Types

- CSV (`.csv`)
- Parquet (`.parquet`, `.parq`)
- Arrow (`.arrow`)

## Installation & Development

```bash
# Clone and install
git clone https://github.com/rq-research/data-viewer.git
cd data-viewer
npm install

# Build
npm run compile

# Run in VS Code
code .
# Press F5 to launch Extension Development Host
```

## Usage

1. Click any CSV, Parquet, or Arrow file - it opens automatically in the viewer
2. Use the SQL Editor at the bottom to query your data (table name is `my_data`)
3. Press `⌘+Enter` (Mac) or `Ctrl+Enter` (Windows/Linux) to run queries
4. Export results using the toolbar buttons
