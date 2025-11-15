import { DataLoader } from './types';
import { deriveRelationName, formatIdentifierForSql } from '../utils/sqlHelpers';

const ARROW_EXTENSIONS = /\.(arrow|ipc)$/i;

export const arrowLoader: DataLoader = {
  id: 'arrow',
  canLoad(fileName: string) {
    return ARROW_EXTENSIONS.test(fileName);
  },
  async load(fileName, fileBytes, context) {
    const { connection, updateStatus } = context;

    const relationName = deriveRelationName(fileName);
    const relationIdentifier = formatIdentifierForSql(relationName);

    updateStatus('Loading Arrow IPC data…');
    await connection.query(`DROP TABLE IF EXISTS ${relationIdentifier};`);
    await connection.insertArrowFromIPCStream(fileBytes, {
      name: relationName,
      create: true,
    });

    updateStatus('Inspecting Arrow schema…');
    const infoResult = await connection.query(`PRAGMA table_info(${relationIdentifier});`);
    const infoRows = infoResult.toArray();
    const columns = infoRows
      .map((row: any) => row.name)
      .filter((name: any): name is string => typeof name === 'string' && name.length > 0);
    const schema = infoRows.map((row: any) => {
      const name = typeof row.name === 'string' ? row.name : 'column';
      const typeValue = typeof row.type === 'string' ? row.type : 'unknown';
      return { name, type: typeValue };
    });

    if (columns.length === 0) {
      throw new Error('No columns were detected in this Arrow file.');
    }

    return {
      relationName,
      relationIdentifier,
      columns,
      schema,
    };
  },
};
