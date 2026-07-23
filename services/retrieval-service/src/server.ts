import 'dotenv/config';
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { createRuntime } from './runtime.js';

const config = loadConfig();
const { store, engine } = createRuntime(config);

if (config.autoMigrate) {
  await store.initialize();
}

const server = createHttpServer({
  engine,
  store,
  corsOrigin: config.corsOrigin,
});

server.listen(config.port, config.host, () => {
  console.log(`Retrieval service listening on http://${config.host}:${config.port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await store.close();
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
