export interface RetrievalConfig {
  host: string;
  port: number;
  corsOrigin: string;
  autoMigrate: boolean;
  seekdb: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    table: string;
    vectorDimension: number;
  };
  embedding:
    | { provider: 'hash'; dimension: number }
    | {
        provider: 'openai';
        dimension: number;
        url: string;
        apiKey: string;
        model: string;
      };
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function identifier(value: string | undefined, fallback: string, name: string): string {
  const selected = value?.trim() || fallback;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(selected)) {
    throw new Error(`${name} must be a SQL identifier containing only letters, digits, and _.`);
  }
  return selected;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RetrievalConfig {
  const dimension = positiveInteger(
    env.SEEKDB_VECTOR_DIMENSION,
    384,
    'SEEKDB_VECTOR_DIMENSION',
  );
  const provider = env.SEEKDB_EMBEDDING_PROVIDER?.trim().toLowerCase() || 'hash';
  if (provider !== 'hash' && provider !== 'openai') {
    throw new Error('SEEKDB_EMBEDDING_PROVIDER must be "hash" or "openai".');
  }

  const embedding: RetrievalConfig['embedding'] =
    provider === 'openai'
      ? {
          provider: 'openai',
          dimension,
          url: env.SEEKDB_EMBEDDING_URL?.trim() || 'https://api.openai.com/v1/embeddings',
          apiKey: env.SEEKDB_EMBEDDING_API_KEY?.trim() || '',
          model: env.SEEKDB_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
        }
      : { provider: 'hash', dimension };

  if (embedding.provider === 'openai' && !embedding.apiKey) {
    throw new Error('SEEKDB_EMBEDDING_API_KEY is required for the openai provider.');
  }

  return {
    host: env.RETRIEVAL_HOST?.trim() || '127.0.0.1',
    port: positiveInteger(env.RETRIEVAL_PORT, 8787, 'RETRIEVAL_PORT'),
    corsOrigin: env.RETRIEVAL_CORS_ORIGIN?.trim() || 'http://localhost:4173',
    autoMigrate: boolean(env.SEEKDB_AUTO_MIGRATE, true),
    seekdb: {
      host: env.SEEKDB_HOST?.trim() || '127.0.0.1',
      port: positiveInteger(env.SEEKDB_PORT, 2881, 'SEEKDB_PORT'),
      user: env.SEEKDB_USER?.trim() || 'root',
      password: env.SEEKDB_PASSWORD || '',
      database: identifier(env.SEEKDB_DATABASE, 'forexplore', 'SEEKDB_DATABASE'),
      table: identifier(env.SEEKDB_TABLE, 'code_symbols', 'SEEKDB_TABLE'),
      vectorDimension: dimension,
    },
    embedding,
  };
}
