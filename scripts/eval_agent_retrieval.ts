// scripts/eval_agent_retrieval.ts
// 使用 DeepSeek 官方 API（deepseek-v4-pro 模型）作为 Agent 检索器
// 前置：设置 DEEPSEEK_API_KEY 环境变量
// 注册获取 API Key: https://platform.deepseek.com/api_keys

import * as fs from 'fs';

// ---- 语料库仓库摘要（注入到 prompt 中，无需工具调用）----
const CORPUS_PREVIEWS: Record<string, string> = {};

function loadCorpusPreviews(): void {
  const corpusDir = 'fixtures/code-corpus';
  for (const repo of fs.readdirSync(corpusDir)) {
    const repoPath = `${corpusDir}/${repo}`;
    if (!fs.statSync(repoPath).isDirectory()) continue;

    const manifestPath = `${repoPath}/manifest.json`;
    let lang = 'unknown';
    if (fs.existsSync(manifestPath)) {
      try { lang = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).language || lang; } catch {}
    }

    // 收集源文件列表（排除测试文件）
    const files = listSourceFiles(repoPath, lang);
    const samples = files.slice(0, 6).join(', ');
    CORPUS_PREVIEWS[repo] = `${repo} [${lang}]: ${files.length} src files, e.g. ${samples}`;
  }
}

function listSourceFiles(dir: string, lang: string): string[] {
  const exts: Record<string, string[]> = {
    TypeScript: ['.ts'], Python: ['.py'], Java: ['.java'], Go: ['.go'], Rust: ['.rs'],
  };
  const validExts = exts[lang] || [];
  const result: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = `${d}/${entry.name}`;
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.includes('_test') || entry.name.includes('test_') || entry.name.includes('.test.') || entry.name.includes('spec')) continue;
      if (validExts.some(e => entry.name.endsWith(e))) result.push(full.replace(dir + '/', ''));
    }
  }
  walk(dir);
  return result;
}

// ---- 构造两阶段提示词 ----

function buildTop10Prompt(task: any): string {
  const corpus = Object.values(CORPUS_PREVIEWS).join('\n');
  return `Find the TOP-10 most relevant code symbols from this corpus for the task below. Match BEHAVIOR, not keywords. Prefer cross-language behavioral matches.

## Corpus (${Object.keys(CORPUS_PREVIEWS).length} repos)
${corpus}

## Target
Symbol: ${task.targetSymbol}
Requirement: ${task.requirement}
Constraints: ${task.constraints.join('; ')}
Expected: ${task.expectedBehaviors.join('; ')}

Return ONLY a JSON array (no markdown, no extra text):
[{"rank":1,"repository":"repo-name","symbol":"FuncName","path":"src/...","language":"ts/py/java/go/rs","reason":"behavioral match reason"}, ...]`;
}

function buildTop20Prompt(task: any, top10Symbols: string[]): string {
  const excludeList = top10Symbols.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `I already found these top-10 symbols for the task "${task.targetSymbol}: ${task.requirement}":
${excludeList}

Now find the NEXT 10 (rank 11-20) from the same corpus. Exclude the symbols above. Same criteria: behavioral match over keyword match, cross-language OK.

Corpus repos: ${Object.keys(CORPUS_PREVIEWS).join(', ')}

Return ONLY a JSON array (no markdown, no extra text):
[{"rank":11,"repository":"repo-name","symbol":"FuncName","path":"src/...","language":"ts/py/java/go/rs","reason":"behavioral match reason"}, ...]`;
}

// ---- JSON 解析 ----

function parseTopNResponse(text: string): any[] {
  if (!text || text.trim().length === 0) {
    console.error('  ⚠ Received empty response from model');
    return [];
  }
  // 尝试直接解析
  try { const r = JSON.parse(text); if (Array.isArray(r)) return r; } catch {}
  // 从 markdown 代码块提取
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (match) try { const r = JSON.parse(match[1]); if (Array.isArray(r)) return r; } catch {}
  // 从 [ ... ] 提取
  const arrMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (arrMatch) try { const r = JSON.parse(arrMatch[0]); if (Array.isArray(r)) return r; } catch {}
  console.error(`  ⚠ Could not parse JSON. Raw response (first 500 chars):\n  ${text.slice(0, 500)}`);
  return [];
}

// ---- 指标计算 ----

interface SearchCandidate {
  title: string;
  repository: string;
  language: string;
  score: { overall: number };
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

  const precision = (top: SearchCandidate[]) => {
    const rel = top.filter(c => (taskGT.get(`${c.repository}::${c.title}`) ?? 0) >= 2).length;
    return rel / top.length;
  };

  const totalRelevant = [...taskGT.values()].filter(v => v >= 2).length;
  const recall = (top: SearchCandidate[]) => {
    const found = top.filter(c => (taskGT.get(`${c.repository}::${c.title}`) ?? 0) >= 2).length;
    return totalRelevant === 0 ? 0 : found / totalRelevant;
  };

  const dcg = (top: SearchCandidate[]) =>
    top.reduce((sum, c, i) => sum + (Math.pow(2, taskGT.get(`${c.repository}::${c.title}`) ?? 0) - 1) / Math.log2(i + 2), 0);

  const idcg = (k: number) => {
    const sorted = [...taskGT.values()].sort((a, b) => b - a).slice(0, k);
    return sorted.reduce((sum, rel, i) => sum + (Math.pow(2, rel) - 1) / Math.log2(i + 2), 0);
  };
  const ndcg = (top: SearchCandidate[]) => { const id = idcg(top.length); return id === 0 ? 0 : dcg(top) / id; };

  const mrr = (() => {
    for (let i = 0; i < candidates.length; i++) {
      if ((taskGT.get(`${candidates[i].repository}::${candidates[i].title}`) ?? 0) === 3) return 1 / (i + 1);
    }
    return 0;
  })();

  const distractorCount = top3.filter(c => (taskGT.get(`${c.repository}::${c.title}`) ?? -1) === 0).length;

  return {
    precision3: precision(top3), precision5: precision(top5), precision10: precision(top10),
    recall10: recall(top10), recall20: recall(top20),
    ndcg3: ndcg(top3), ndcg5: ndcg(top5), ndcg10: ndcg(top10), ndcg20: ndcg(top20),
    mrr, distractorAt3: distractorCount,
    highHit3: top3.some(c => (taskGT.get(`${c.repository}::${c.title}`) ?? 0) === 3),
    highHit10: top10.some(c => (taskGT.get(`${c.repository}::${c.title}`) ?? 0) === 3),
  };
}

// ---- API 调用（轻量重试）----

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function queryAgent(prompt: string, maxTokens = 2048, retries = 4): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const resp = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY!}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        max_tokens: maxTokens,
        temperature: 0.1,
        thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const content = data.choices[0].message.content;
      // deepseek-v4-pro 可能返回 null/空 content，或把内容放在 reasoning_content 中
      if (content) return content;
      if (data.choices[0].message.reasoning_content) return data.choices[0].message.reasoning_content;
      console.error(`  ⚠ Empty response content. Full response: ${JSON.stringify(data).slice(0, 500)}`);
      throw new Error('Empty response from API');
    }

    if (resp.status === 429 || resp.status >= 500) {
      const delay = Math.pow(2, attempt + 1) * 2000; // 4s, 8s, 16s, 32s
      console.error(`  ⚠ API ${resp.status}, retrying in ${delay / 1000}s (${attempt + 1}/${retries})...`);
      await sleep(delay);
      continue;
    }

    throw new Error(`API error: ${resp.status} ${await resp.text()}`);
  }
  throw new Error(`API rate limited after ${retries} retries`);
}

// ---- 主流程 ----

async function main() {
  console.log('Loading corpus previews...');
  loadCorpusPreviews();
  console.log(`  ${Object.keys(CORPUS_PREVIEWS).length} repos indexed`);

  const tasks = loadTasks('fixtures/benchmark/tasks.jsonl');
  const relevance = loadRelevance('fixtures/benchmark/relevance.jsonl');
  const gt = buildGroundTruthMap(relevance);

  console.log('='.repeat(80));
  console.log('LLM Agent Retrieval Evaluation (2-phase: top-10 → top-20)');
  console.log('='.repeat(80));

  const allMetrics: any[] = [];
  const allTop10: any[] = [];
  const allTop20: any[] = [];

  // 只执行 task 4-5（前 3 个已完成）
  const pendingTasks = tasks.filter((t: any) => t.taskId === 'trade-consumer-004' || t.taskId === 'audit-buffer-005');

  for (let t = 0; t < pendingTasks.length; t++) {
    const task = pendingTasks[t];
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Task ${t + 1}/${pendingTasks.length} (overall ${tasks.indexOf(task) + 1}/${tasks.length}): ${task.taskId}`);

    if (t > 0) {
      console.log('  Waiting 5s before next task...');
      await sleep(5000);
    }

    // ---- Phase 1: 获取 Top-10 ----
    console.log('  [Phase 1] Requesting top-10...');
    const prompt10 = buildTop10Prompt(task);
    console.log(`    prompt: ${prompt10.length} chars, ~${Math.round(prompt10.length / 3)} tokens`);
    const resp10 = await queryAgent(prompt10, 2048);
    const top10 = parseTopNResponse(resp10);
    console.log(`    received ${top10.length} results`);

    // 从 top-10 提取已命中符号用于去重
    const seenSymbols = top10.map((c: any) => `${c.repository}::${c.symbol}`);

    // ---- Phase 2: 获取 Top-20（补充 11-20）----
    console.log('  [Phase 2] Requesting next 10 (rank 11-20)...');
    await sleep(2000); // 请求间短暂等待
    const prompt20 = buildTop20Prompt(task, seenSymbols);
    console.log(`    prompt: ${prompt20.length} chars, ~${Math.round(prompt20.length / 3)} tokens`);
    const resp20 = await queryAgent(prompt20, 2048);
    const next10 = parseTopNResponse(resp20);
    console.log(`    received ${next10.length} results`);

    // 合并 top-10 + next-10 → top-20
    const top20 = [...top10, ...next10];

    // 映射到 SearchCandidate 格式
    const mapCandidates = (raw: any[]) => raw.map((c: any) => ({
      title: c.symbol,
      repository: c.repository,
      language: c.language,
      score: { overall: 0 },
    }));

    const mappedTop20 = mapCandidates(top20);
    const metrics = computeMetrics(task.taskId, mappedTop20, gt);

    console.log(`  ── Results ──`);
    console.log(`  Precision@3:   ${(metrics.precision3 * 100).toFixed(1)}%`);
    console.log(`  Precision@10:  ${(metrics.precision10 * 100).toFixed(1)}%`);
    console.log(`  Recall@10:     ${(metrics.recall10 * 100).toFixed(1)}%`);
    console.log(`  Recall@20:     ${(metrics.recall20 * 100).toFixed(1)}%`);
    console.log(`  NDCG@10:       ${metrics.ndcg10.toFixed(3)}`);
    console.log(`  NDCG@20:       ${metrics.ndcg20.toFixed(3)}`);
    console.log(`  MRR:           ${metrics.mrr.toFixed(3)}`);
    console.log(`  Distractor@3:  ${metrics.distractorAt3}`);
    console.log(`  High-Hit@3:    ${metrics.highHit3}`);
    console.log(`  High-Hit@10:   ${metrics.highHit10}`);

    console.log('  Top-10:');
    top10.forEach((c: any, i: number) => {
      const key = `${c.repository}::${c.symbol}`;
      const rel = gt.get(task.taskId)?.get(key) ?? -1;
      const relName = ['distractor', 'low', 'medium', 'high'][rel] ?? 'unknown';
      console.log(`    ${i + 1}. [${relName}] ${c.repository}/${c.symbol} (${c.language})`);
    });

    // 收集结果
    const labelResults = (raw: any[]) => raw.map((c: any, i: number) => {
      const key = `${c.repository}::${c.symbol}`;
      const rel = gt.get(task.taskId)?.get(key) ?? -1;
      const relName = ['distractor', 'low', 'medium', 'high'][rel] ?? 'unknown';
      return { rank: i + 1, repository: c.repository, symbol: c.symbol, language: c.language, path: c.path || '', relevance: relName, relevance_reason: c.reason || '' };
    });

    allTop10.push({ taskId: task.taskId, candidates: labelResults(top10) });
    allTop20.push({ taskId: task.taskId, candidates: labelResults(top20) });
    allMetrics.push({ taskId: task.taskId, ...metrics });
  }

  // 汇总
  console.log('\n' + '='.repeat(80));
  console.log(
    `AGGREGATE METRICS (${allMetrics.length}/${tasks.length} selected tasks; not a full benchmark)`,
  );
  console.log('='.repeat(80));

  const avg = (key: string) => allMetrics.reduce((s, m) => s + m[key], 0) / allMetrics.length;
  console.log(`  Avg Precision@3:   ${(avg('precision3') * 100).toFixed(1)}%`);
  console.log(`  Avg Precision@10:  ${(avg('precision10') * 100).toFixed(1)}%`);
  console.log(`  Avg Recall@10:     ${(avg('recall10') * 100).toFixed(1)}%`);
  console.log(`  Avg Recall@20:     ${(avg('recall20') * 100).toFixed(1)}%`);
  console.log(`  Avg NDCG@10:       ${avg('ndcg10').toFixed(3)}`);
  console.log(`  Avg NDCG@20:       ${avg('ndcg20').toFixed(3)}`);
  console.log(`  Avg MRR:           ${avg('mrr').toFixed(3)}`);
  console.log(`  Avg Distractor@3:  ${avg('distractorAt3').toFixed(1)}`);
  console.log(`  High-Hit@3 Rate:   ${allMetrics.filter(m => m.highHit3).length}/${allMetrics.length}`);
  console.log(`  High-Hit@10 Rate:  ${allMetrics.filter(m => m.highHit10).length}/${allMetrics.length}`);

  const resultsDir = 'results/agent';
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(`${resultsDir}/agent_eval.json`, JSON.stringify(allMetrics, null, 2));
  console.log(`\nMetrics saved to ${resultsDir}/agent_eval.json`);
  fs.writeFileSync(`${resultsDir}/agent_top10.json`, JSON.stringify(allTop10, null, 2));
  console.log(`Top-10 results saved to ${resultsDir}/agent_top10.json`);
  fs.writeFileSync(`${resultsDir}/agent_top20.json`, JSON.stringify(allTop20, null, 2));
  console.log(`Top-20 results saved to ${resultsDir}/agent_top20.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// ---- 辅助函数 ----
function loadTasks(fp: string) {
  return fs.readFileSync(fp, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
}
function loadRelevance(fp: string) {
  return fs.readFileSync(fp, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
}
function buildGroundTruthMap(rel: any[]) {
  const m = new Map<string, Map<string, number>>();
  for (const r of rel) {
    if (!m.has(r.taskId)) m.set(r.taskId, new Map());
    const w = { high: 3, medium: 2, low: 1, distractor: 0 }[r.relevance] ?? 0;
    m.get(r.taskId)!.set(`${r.candidateRepository}::${r.candidateSymbol}`, w);
  }
  return m;
}
