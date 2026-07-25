import 'dotenv/config';
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { AdaptationAdapter } from './adaptation-adapter.js';
import { BackfillAdapter } from './backfill-adapter.js';

const config = loadConfig();

const adapter = new AdaptationAdapter({
  apiKey: config.deepseekApiKey,
  skeletonProjectPath: config.skeletonProjectPath,
  projectRoot: config.projectRoot,
});

const backfill = new BackfillAdapter({
  projectRoot: config.projectRoot || '.',
});

const server = createHttpServer({
  adapter,
  backfill,
  corsOrigin: config.corsOrigin,
});

server.listen(config.port, config.host, () => {
  console.log(`Adaptation service listening on http://${config.host}:${config.port}`);
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

function requestShutdown(): void {
  void shutdown().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);
