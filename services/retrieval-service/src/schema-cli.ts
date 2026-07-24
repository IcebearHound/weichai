import 'dotenv/config';
import { loadConfig } from './config.js';
import { SeekDbStore } from './seekdb-store.js';

const config = loadConfig();
const store = new SeekDbStore(config.seekdb);

try {
  await store.initialize();
  console.log(
    `SeekDB schema ready: ${config.seekdb.database}.${config.seekdb.table} (${config.seekdb.vectorDimension} dimensions)`,
  );
} finally {
  await store.close();
}
