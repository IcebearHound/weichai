export interface AdaptationConfig {
  host: string;
  port: number;
  corsOrigin: string;
  deepseekApiKey: string;
  skeletonProjectPath?: string;
  projectRoot?: string;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdaptationConfig {
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is required.');
  }

  return {
    host: env.ADAPTATION_HOST?.trim() || '127.0.0.1',
    port: positiveInteger(env.ADAPTATION_PORT, 4001, 'ADAPTATION_PORT'),
    corsOrigin: env.ADAPTATION_CORS_ORIGIN?.trim() || 'http://localhost:4173',
    deepseekApiKey: apiKey,
    skeletonProjectPath: env.ADAPTATION_SKELETON_PATH?.trim() || undefined,
    projectRoot: env.ADAPTATION_PROJECT_ROOT?.trim() || undefined,
  };
}
