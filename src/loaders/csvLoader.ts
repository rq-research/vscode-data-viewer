import { DataLoader } from './types';
import { deriveRelationName, formatIdentifierForSql } from '../utils/sqlHelpers';

const CSV_EXTENSIONS = /\.csv$/i;

export const csvLoader: DataLoader = {
  id: 'csv',
  canLoad(fileName: string) {
    return CSV_EXTENSIONS.test(fileName);
  },
  async load(fileName, fileBytes, context) {
    const { db, connection, updateStatus } = context;

    updateStatus('Registering CSV file…');
    await db.registerFileBuffer(fileName, fileBytes);

    const escapedFileName = fileName.replace(/'/g, "''");
    const describeQuery = `DESCRIBE SELECT * FROM read_csv('${escapedFileName}', header=true);`;
    updateStatus('Inspecting CSV columns…');
    const describeResult = await connection.query(describeQuery);
    const describeRows = describeResult.toArray();
    const columns = describeRows
      .map((row: any) => row.column_name)
      .filter((name: any): name is string => typeof name === 'string' && name.length > 0);
    const schema = describeRows.map((row: any) => {
      const name = typeof row.column_name === 'string' ? row.column_name : 'column';
      const typeValue =
        typeof row.column_type === 'string'
          ? row.column_type
          : typeof row.column_type === 'number'
            ? String(row.column_type)
            : typeof row.type === 'string'
              ? row.type
              : 'unknown';
      return { name, type: typeValue };
    });

    if (columns.length === 0) {
      throw new Error('No columns were detected in this CSV file.');
    }

    const relationName = deriveRelationName(fileName);
    const relationIdentifier = formatIdentifierForSql(relationName);

    updateStatus(`Creating '${relationName}' view…`);
    const createViewQuery = `
      CREATE OR REPLACE TEMP VIEW ${relationIdentifier} AS 
      SELECT * FROM read_csv('${escapedFileName}', header=true);
    `;
    await connection.query(createViewQuery);

    return {
      relationName,
      relationIdentifier,
      columns,
      schema,
    };
  },
};
