import * as duckdb from '@duckdb/duckdb-wasm';

export interface LoaderContext {
  db: duckdb.AsyncDuckDB;
  connection: duckdb.AsyncDuckDBConnection;
  updateStatus: (message: string) => void;
}

export interface LoadResult {
  relationName: string;
  relationIdentifier: string;
  columns: string[];
  schema: { name: string; type: string }[];
}

export interface DataLoader {
  id: string;
  canLoad: (fileName: string) => boolean;
  load: (
    fileName: string,
    fileBytes: Uint8Array,
    context: LoaderContext
  ) => Promise<LoadResult>;
}
