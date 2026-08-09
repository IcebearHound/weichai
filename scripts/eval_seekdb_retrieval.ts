// scripts/eval_seekdb_retrieval.ts
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

interface RelevanceRecord {
  taskId: string;
  candidateRepository: string;
  candidateSymbol: string;
  relevance: 'high' | 'medium' | 'low' | 'distractor';
}

interface SearchCandidate {
  id: string;
  title: string;
  repository: string;
  language: string;
  score: { overall: number };
}

interface TaskRecord {
  taskId: string;
  targetSymbol: string;
  targetPath: string;
  requirement: string;
  constraints: string[];
}

const RELEVANCE_WEIGHT: Record<string, number> = {
  high: 3, medium: 2, low: 1, distractor: 0,
};

function loadRelevance(filepath: string): RelevanceRecord[] {
  const raw = fs.readFileSync(filepath, 'utf-8').trim();
  return raw.split('\n').map(line => JSON.parse(line));
}

function loadTasks(filepath: string): TaskRecord[] {
  const raw = fs.readFileSync(filepath, 'utf-8').trim();
  return raw.split('\n').map(line => JSON.parse(line));
}

function buildGroundTruthMap(relevance: RelevanceRecord[]): Map<string, Map<string, number>> {
  const map = new Map<string, Map<string, number>>();
  for (const r of relevance) {
    if (!map.has(r.taskId)) map.set(r.taskId, new Map());
    const key = `${r.candidateRepository}::${r.candidateSymbol}`;
    map.get(r.taskId)!.set(key, RELEVANCE_WEIGHT[r.relevance]);
  }
  return map;
}

function computeMetrics(
  taskId: string,
  candidates: SearchCandidate[],
  gt: Map<string, Map<string, number>>
) {
  const taskGT = gt.get(taskId)!;
  const top3 = candidates.slice(0, 3);
  const top5 = candidates.slice(0, 5);
  const top10 = candidates.slice(0, 10);
  const top20 = candidates.slice(0, 20);

  // precision@k (count high+medium in top-k / k)
  const precision = (top: SearchCandidate[]) => {
    const rel = top.filter(c => {
      const key = `${c.repository}::${c.title}`;
      return (taskGT.get(key) ?? 0) >= 2; // medium or high
    }).length;
    return rel / top.length;
  };

  // recall@k
  const totalRelevant = [...taskGT.values()].filter(v => v >= 2).length;
  const recall = (top: SearchCandidate[]) => {
    const found = top.filter(c => {
      const key = `${c.repository}::${c.title}`;
      return (taskGT.get(key) ?? 0) >= 2;
    }).length;
    return found / totalRelevant;
  };

  // NDCG@k
  const dcg = (top: SearchCandidate[]) => {
    return top.reduce((sum, c, i) => {
      const key = `${c.repository}::${c.title}`;
      const rel = taskGT.get(key) ?? 0;
      return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    }, 0);
  };
  const idcg = (k: number) => {
    const sorted = [...taskGT.values()].sort((a, b) => b - a).slice(0, k);
    return sorted.reduce((sum, rel, i) => {
      return sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2);
    }, 0);
  };
  const ndcg = (top: SearchCandidate[]) => {
    const id = idcg(top.length);
    return id === 0 ? 0 : dcg(top) / id;
  };

  // MRR
  const mrr = (() => {
    for (let i = 0; i < candidates.length; i++) {
      const key = `${candidates[i].repository}::${candidates[i].title}`;
      if ((taskGT.get(key) ?? 0) === 3) return 1 / (i + 1); // high
    }
    return 0;
  })();

  // distractor count in top-3
  const distractorCount = top3.filter(c => {
    const key = `${c.repository}::${c.title}`;
    return (taskGT.get(key) ?? -1) === 0;
  }).length;

  return {
    precision3: precision(top3),
    precision5: precision(top5),
    precision10: precision(top10),
    recall10: recall(top10),
    recall20: recall(top20),
    ndcg3: ndcg(top3),
    ndcg5: ndcg(top5),
    ndcg10: ndcg(top10),
    ndcg20: ndcg(top20),
    mrr,
    distractorAt3: distractorCount,
    highHit3: top3.some(c => {
      const key = `${c.repository}::${c.title}`;
      return (taskGT.get(key) ?? 0) === 3;
    }),
    highHit10: top10.some(c => {
      const key = `${c.repository}::${c.title}`;
      return (taskGT.get(key) ?? 0) === 3;
    }),
  };
}

async function searchSeekDB(task: TaskRecord): Promise<SearchCandidate[]> {
  const body = {
    target: {
      id: task.taskId,
      name: task.targetSymbol.split('.').pop()!,
      kind: 'function',
      path: task.targetPath,
      language: 'TypeScript',
      signature: `${task.targetSymbol.split('.').pop()!}(...): Promise<any>`,
    },
    requirement: task.requirement,
    topK: 20,
    retrievalMode: 'hybrid',
    repositoryScopes: [],
  };

  const resp = await fetch('http://127.0.0.1:8787/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) throw new Error(`Search failed: ${resp.status}`);
  const data = await resp.json();
  return data.candidates;
}

async function main() {
  const tasks = loadTasks(path.join(REPO_ROOT, 'fixtures/benchmark/tasks.jsonl'));
  const relevance = loadRelevance(path.join(REPO_ROOT, 'fixtures/benchmark/relevance.jsonl'));
  const gt = buildGroundTruthMap(relevance);

  console.log('='.repeat(80));
  console.log('SeekDB Retrieval Evaluation');
  console.log('='.repeat(80));

  const allMetrics: any[] = [];
  const allTop10: any[] = [];
  const allTop20: any[] = [];

  for (const task of tasks) {
    console.log(`\n--- ${task.taskId} ---`);
    const candidates = await searchSeekDB(task);
    const metrics = computeMetrics(task.taskId, candidates, gt);

    console.log(`  Precision@3:  ${(metrics.precision3 * 100).toFixed(1)}%`);
    console.log(`  Precision@5:  ${(metrics.precision5 * 100).toFixed(1)}%`);
    console.log(`  Precision@10: ${(metrics.precision10 * 100).toFixed(1)}%`);
    console.log(`  Recall@10:    ${(metrics.recall10 * 100).toFixed(1)}%`);
    console.log(`  Recall@20:    ${(metrics.recall20 * 100).toFixed(1)}%`);
    console.log(`  NDCG@10:      ${metrics.ndcg10.toFixed(3)}`);
    console.log(`  NDCG@20:      ${metrics.ndcg20.toFixed(3)}`);
    console.log(`  MRR:          ${metrics.mrr.toFixed(3)}`);
    console.log(`  Distractor@3: ${metrics.distractorAt3}`);
    console.log(`  High-Hit@3:   ${metrics.highHit3}`);
    console.log(`  High-Hit@10:  ${metrics.highHit10}`);

    // print top-10 for manual verification
    console.log('  Top-10:');
    candidates.slice(0, 10).forEach((c, i) => {
      const key = `${c.repository}::${c.title}`;
      const rel = gt.get(task.taskId)?.get(key) ?? -1;
      const relName = ['distractor', 'low', 'medium', 'high'][rel] ?? 'unknown';
      console.log(`    ${i + 1}. [${relName}] ${c.repository}/${c.title} (${c.language}) score=${c.score.overall.toFixed(3)}`);
    });

    // collect top-10 and top-20 for saving
    const top10Results = candidates.slice(0, 10).map((c, i) => {
      const key = `${c.repository}::${c.title}`;
      const rel = gt.get(task.taskId)?.get(key) ?? -1;
      const relName = ['distractor', 'low', 'medium', 'high'][rel] ?? 'unknown';
      return {
        rank: i + 1,
        repository: c.repository,
        symbol: c.title,
        language: c.language,
        score: c.score.overall,
        relevance: relName,
      };
    });

    const top20Results = candidates.slice(0, 20).map((c, i) => {
      const key = `${c.repository}::${c.title}`;
      const rel = gt.get(task.taskId)?.get(key) ?? -1;
      const relName = ['distractor', 'low', 'medium', 'high'][rel] ?? 'unknown';
      return {
        rank: i + 1,
        repository: c.repository,
        symbol: c.title,
        language: c.language,
        score: c.score.overall,
        relevance: relName,
      };
    });

    allTop10.push({ taskId: task.taskId, candidates: top10Results });
    allTop20.push({ taskId: task.taskId, candidates: top20Results });
    allMetrics.push({ taskId: task.taskId, ...metrics });
  }

  // aggregate
  console.log('\n' + '='.repeat(80));
  console.log('AGGREGATE METRICS (macro-average across 5 tasks)');
  console.log('='.repeat(80));

  const avg = (key: string) => allMetrics.reduce((s, m) => s + m[key], 0) / allMetrics.length;
  console.log(`  Avg Precision@3:  ${(avg('precision3') * 100).toFixed(1)}%`);
  console.log(`  Avg Precision@5:  ${(avg('precision5') * 100).toFixed(1)}%`);
  console.log(`  Avg Precision@10: ${(avg('precision10') * 100).toFixed(1)}%`);
  console.log(`  Avg Recall@10:    ${(avg('recall10') * 100).toFixed(1)}%`);
  console.log(`  Avg Recall@20:    ${(avg('recall20') * 100).toFixed(1)}%`);
  console.log(`  Avg NDCG@10:      ${avg('ndcg10').toFixed(3)}`);
  console.log(`  Avg NDCG@20:      ${avg('ndcg20').toFixed(3)}`);
  console.log(`  Avg MRR:          ${avg('mrr').toFixed(3)}`);
  console.log(`  Avg Distractor@3: ${avg('distractorAt3').toFixed(1)}`);
  console.log(`  High-Hit@3 Rate:  ${allMetrics.filter(m => m.highHit3).length}/${allMetrics.length}`);
  console.log(`  High-Hit@10 Rate: ${allMetrics.filter(m => m.highHit10).length}/${allMetrics.length}`);

  // save results to specified paths
  const resultsDir = path.join(REPO_ROOT, 'results/seekdb');
  fs.mkdirSync(resultsDir, { recursive: true });

  fs.writeFileSync(`${resultsDir}/seekdb_eval.json`, JSON.stringify(allMetrics, null, 2));
  console.log(`\nMetrics saved to ${resultsDir}/seekdb_eval.json`);

  fs.writeFileSync(`${resultsDir}/seekdb_top10.json`, JSON.stringify(allTop10, null, 2));
  console.log(`Top-10 results saved to ${resultsDir}/seekdb_top10.json`);

  fs.writeFileSync(`${resultsDir}/seekdb_top20.json`, JSON.stringify(allTop20, null, 2));
  console.log(`Top-20 results saved to ${resultsDir}/seekdb_top20.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
