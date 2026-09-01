import 'dotenv/config';
import { loadConfig } from './config.js';
import { createHttpServer } from './http-server.js';
import { AdaptationAdapter } from './adaptation-adapter.js';
import { ArchitectAgent } from './architect-agent.js';
import { FileStaticAnalysisSnapshotStore } from './analysis-snapshot-store.js';

const config = loadConfig();

const adapter = new AdaptationAdapter({
  apiKey: config.apiKey,
  skeletonProjectPath: config.skeletonProjectPath,
  projectRoot: config.projectRoot,
});

const server = createHttpServer({
  adapter,
  architecturePort: new ArchitectAgent({ apiKey: config.apiKey }),
  staticAnalysisSnapshots: new FileStaticAnalysisSnapshotStore({
    analysisRoot: config.analysisRoot,
  }),
  corsOrigin: config.corsOrigin,
});

server.listen(config.port, config.host, () => {
  console.log(`Adaptation service listening on http://${config.host}:${config.port}`);
  console.log(`Target project: ${config.projectRoot}`);
  console.log(`Static analysis snapshots: ${config.analysisRoot}`);
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
