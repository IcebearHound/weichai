import { useMemo, useReducer, useState } from 'react';
import {
  Blocks,
  Boxes,
  Braces,
  CodeXml,
  Database,
  FileSearch,
  GitCompareArrows,
  PanelLeftClose,
  Play,
  Search,
  Settings2,
  Sparkles,
  Workflow,
} from 'lucide-react';
import type {
  AdaptationStrategy,
  ModuleNode,
  ModuleTarget,
} from '@forexplore/contracts';
import {
  initialWorkflowState,
  selectedCandidate,
  type WorkflowPorts,
  workflowReducer,
} from '@forexplore/workflow-core';
import { CandidateBrowser } from './features/candidate-selection/CandidateBrowser';
import { PatchReview } from './features/patch-review/PatchReview';
import {
  RepositoryModulePlan,
} from './features/repository-planning/RepositoryModulePlan';
import {
  defaultRepositoryModules,
  type RepositoryModuleSummary,
} from './features/repository-planning/repository-modules';
import {
  ModuleTree,
  type ModuleImplementationFilter,
} from './features/target-selection/ModuleTree';
import { TargetModulePartition } from './features/target-selection/TargetModulePartition';
import { WorkflowRail } from './features/workflow-progress/WorkflowRail';

type ModuleWorkspaceView = 'target' | 'repository';

const moduleFilters: Array<{ id: ModuleImplementationFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'implemented', label: '已完成' },
  { id: 'unimplemented', label: '未完成' },
];

const strategyOptions: Array<{
  id: AdaptationStrategy;
  label: string;
  detail: string;
}> = [
  { id: 'translate', label: '翻译实现', detail: '转换到目标语言并保持行为' },
  { id: 'bridge', label: '运行时桥接', detail: '保留源实现，通过协议调用' },
  { id: 'wrap', label: '适配器封装', detail: '添加目标接口与数据转换层' },
  { id: 'reuse', label: '同语言复用', detail: '最小修改直接嵌入' },
];

function RequirementPanel({
  state,
  dispatch,
  onSearch,
  searchProvider,
}: {
  state: typeof initialWorkflowState;
  dispatch: React.Dispatch<Parameters<typeof workflowReducer>[1]>;
  onSearch: () => void;
  searchProvider: string;
}) {
  const canSearch = Boolean(state.target);

  return (
    <div className="requirement-layout">
      <section className="requirement-main">
        <div className="section-intro">
          <div className="eyebrow">02 / 候选检索</div>
          <h1>补充需求并检索相似实现</h1>
          <p>
            01B 已锁定目标模块与实现状态；检索接口同时接收自然语言需求和目标符号契约。
          </p>
        </div>

        <label className="field-label" htmlFor="requirement">
          功能需求（可选）
        </label>
        <textarea
          id="requirement"
          className="requirement-textarea"
          value={state.requirement}
          onChange={(event) => dispatch({ type: 'SET_REQUIREMENT', value: event.target.value })}
          placeholder="例如：为报价读取增加 5 秒 TTL 缓存、并发请求合并、800ms 超时与失败时 stale 回退；保持现有 QuoteRequest → Task<Quote> 接口不变。"
        />
        <div className="field-hint">
          <span>{state.requirement.trim().length} 字符</span>
          <span>留空时使用目标名称、签名和源码注释检索。</span>
        </div>

        <div className="query-preview">
          <div className="panel-caption">检索请求预览</div>
          <dl>
            <div>
              <dt>symbol</dt>
              <dd>{state.target?.signature}</dd>
            </div>
            <div>
              <dt>scope</dt>
              <dd>server://authorized-repositories</dd>
            </div>
            <div>
              <dt>language</dt>
              <dd>{state.target?.language}</dd>
            </div>
          </dl>
        </div>
      </section>

      <aside className="search-config">
        <section>
          <h3>混合检索</h3>
        </section>

        <section>
          <label className="range-heading" htmlFor="top-k">
            <span>返回方案数</span>
            <strong>Top {state.topK}</strong>
          </label>
          <input
            id="top-k"
            type="range"
            min="2"
            max="5"
            value={state.topK}
            onChange={(event) =>
              dispatch({ type: 'SET_TOP_K', value: Number(event.target.value) })
            }
          />
          <div className="range-scale">
            <span>2</span>
            <span>5</span>
          </div>
        </section>

        <section className="repository-scope">
          <h3>代码仓范围</h3>
          <label>
            <input type="checkbox" defaultChecked disabled /> 服务端授权仓库
            <span>由检索服务 allow-list 决定</span>
          </label>
          <label>
            <input type="checkbox" defaultChecked disabled /> 当前检索语料
            <span>{searchProvider === 'SeekDB' ? 'SeekDB code corpus' : 'Mock catalog'}</span>
          </label>
        </section>

        <button
          type="button"
          className="button-primary search-action"
          disabled={!canSearch || state.pending === 'search'}
          onClick={onSearch}
        >
          {state.pending === 'search' ? (
            <span className="loading-dot" />
          ) : (
            <Search size={15} />
          )}
          {state.pending === 'search' ? '正在调用检索接口…' : '检索相似实现'}
        </button>
      </aside>
    </div>
  );
}

function SelectionFooter({
  state,
  dispatch,
  onAdapt,
  adaptationProvider,
}: {
  state: typeof initialWorkflowState;
  dispatch: React.Dispatch<Parameters<typeof workflowReducer>[1]>;
  onAdapt: () => void;
  adaptationProvider: string;
}) {
  const candidate = selectedCandidate(state);
  if (!candidate) return null;
  const realAdaptation = adaptationProvider !== 'Mock';

  return (
    <div className="selection-workbench">
      <div className="decision-fields">
        <label>
          <span>适配方式</span>
          <select
            value={state.strategy}
            onChange={(event) =>
              dispatch({
                type: 'SET_STRATEGY',
                value: event.target.value as AdaptationStrategy,
              })
            }
          >
            {strategyOptions.map((option) => (
              <option
                key={option.id}
                value={option.id}
                disabled={realAdaptation && option.id !== 'translate'}
              >
                {option.label} · {option.detail}
                {realAdaptation && option.id !== 'translate' ? '（演示服务暂不支持）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="decision-notes">
          <span>人工备注 / 额外约束</span>
          <input
            type="text"
            value={state.decisionNotes}
            onChange={(event) =>
              dispatch({ type: 'SET_DECISION_NOTES', value: event.target.value })
            }
            placeholder="例如：缓存必须通过构造函数注入；禁止新增全局状态。"
          />
        </label>
      </div>
      <button
        type="button"
        className="button-primary"
        onClick={onAdapt}
      >
        <Sparkles size={15} /> 使用此方案并生成适配
      </button>
    </div>
  );
}

function Inspector({
  state,
  searchProvider,
  adaptationProvider,
  repositoryModuleCount,
  workspaceView,
}: {
  state: typeof initialWorkflowState;
  searchProvider: string;
  adaptationProvider: string;
  repositoryModuleCount: number;
  workspaceView: ModuleWorkspaceView | null;
}) {
  const candidate = selectedCandidate(state);
  return (
    <aside className="inspector-pane">
      <div className="pane-heading">
        <span>上下文</span>
        <Settings2 size={14} />
      </div>

      <section className="inspector-section">
        <h3>{workspaceView === 'repository' ? '历史仓分析' : '目标符号'}</h3>
        {workspaceView === 'repository' ? (
          <div className="repository-inspector-card">
            <Database size={16} />
            <strong>{repositoryModuleCount} 个功能模块</strong>
            <span>静态依赖证据已绑定</span>
            <span>summary.json 已生成</span>
          </div>
        ) : state.target ? (
          <div className="target-card">
            <div className="target-kind">
              {state.target.kind === 'class' ? <Boxes size={15} /> : <Braces size={15} />}
              {state.target.kind}
              {state.target.implementationStatus === 'unimplemented' ? (
                <span className="implementation-status">待实现</span>
              ) : null}
            </div>
            <strong>{state.target.name}</strong>
            <code>{state.target.signature}</code>
            {state.target.documentation ? (
              <p className="target-documentation">
                <span>源码注释</span>
                {state.target.documentation}
              </p>
            ) : null}
            <span>
              {state.target.path}:{state.target.line}
            </span>
          </div>
        ) : (
          <p className="empty-copy">从 01B 工作区树选择 class 或 function。</p>
        )}
      </section>

      <section className="inspector-section">
        <h3>工作流端口</h3>
        <div className="port-list">
          <div>
            <FileSearch size={14} />
            <span>
              <strong>CodeSearchPort</strong>
              <small>{searchProvider} · Top-K</small>
            </span>
            <em>ready</em>
          </div>
          <div>
            <GitCompareArrows size={14} />
            <span>
              <strong>CodeAdaptationPort</strong>
              <small>{adaptationProvider} · Java → C#</small>
            </span>
            <em>ready</em>
          </div>
          <div>
            <CodeXml size={14} />
            <span>
              <strong>CodeBackfillPort</strong>
              <small>Mock · workspace edit</small>
            </span>
            <em>ready</em>
          </div>
        </div>
      </section>

      {candidate ? (
        <section className="inspector-section">
          <h3>当前决策</h3>
          <dl className="decision-summary">
            <div>
              <dt>方案</dt>
              <dd>{candidate.title}</dd>
            </div>
            <div>
              <dt>语言</dt>
              <dd>
                {candidate.language} → {state.target?.language}
              </dd>
            </div>
            <div>
              <dt>策略</dt>
              <dd>{state.strategy}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </aside>
  );
}

export interface AppProps {
  ports: WorkflowPorts;
  moduleTree: ModuleNode;
  repositoryModules?: RepositoryModuleSummary[];
  searchProvider?: string;
  adaptationProvider?: string;
}

export default function App({
  ports,
  moduleTree,
  repositoryModules = defaultRepositoryModules,
  searchProvider = 'Mock',
  adaptationProvider = 'Mock',
}: AppProps) {
  const [state, dispatch] = useReducer(workflowReducer, initialWorkflowState);
  const [workspaceView, setWorkspaceView] = useState<ModuleWorkspaceView | null>('target');
  const [targetQuery, setTargetQuery] = useState('');
  const [targetFilter, setTargetFilter] = useState<ModuleImplementationFilter>('all');
  const candidate = useMemo(() => selectedCandidate(state), [state]);

  function handleTargetSelect(target: ModuleTarget) {
    if (state.target?.id !== target.id) dispatch({ type: 'SELECT_TARGET', target });
  }

  function handleTargetConfirm() {
    if (state.stage === 'target') dispatch({ type: 'CONFIRM_TARGET' });
    setWorkspaceView(null);
  }

  async function handleSearch() {
    if (!state.target) return;
    dispatch({ type: 'SEARCH_START' });
    try {
      const candidates = await ports.search.search({
        target: state.target,
        requirement: state.requirement.trim(),
        topK: state.topK,
        candidateLanguages: adaptationProvider === 'Mock' ? undefined : ['Java'],
      });
      dispatch({ type: 'SEARCH_SUCCESS', candidates });
    } catch (error) {
      dispatch({
        type: 'SEARCH_FAILURE',
        message: error instanceof Error ? error.message : '检索接口调用失败。',
      });
    }
  }

  async function handleAdapt() {
    if (!state.target || !candidate) return;
    dispatch({ type: 'ADAPT_START' });
    try {
      const result = await ports.adaptation.adapt({
        target: state.target,
        candidate,
        requirement: state.requirement,
        strategy: state.strategy,
        decisionNotes: state.decisionNotes,
      });
      dispatch({ type: 'ADAPT_SUCCESS', result });
    } catch (error) {
      dispatch({
        type: 'ADAPT_FAILURE',
        message: error instanceof Error ? error.message : '适配接口调用失败。',
      });
    }
  }

  async function handleApply() {
    if (!state.adaptation) return;
    dispatch({ type: 'APPLY_START' });
    try {
      const result = await ports.backfill.apply(state.adaptation.files);
      dispatch({ type: 'APPLY_SUCCESS', result });
    } catch (error) {
      dispatch({
        type: 'APPLY_FAILURE',
        message: error instanceof Error ? error.message : '回填接口调用失败。',
      });
    }
  }

  return (
    <div className="app-shell">
      <header className="titlebar">
        <div className="product-mark">
          <span className="product-glyph">FX</span>
          <strong>ForeXplore</strong>
          <span>模块复用工作流</span>
        </div>
        <div className="command-center">
          <Search size={13} />
          <span>搜索模块、方案或工作流命令</span>
          <kbd>Ctrl K</kbd>
        </div>
        <div className="titlebar-meta">
          <span className="mock-state">PROTOTYPE</span>
          <button type="button" aria-label="运行当前流程">
            <Play size={14} />
          </button>
        </div>
      </header>

      <aside className="activity-rail" aria-label="主导航">
        <button type="button" className="is-active" aria-label="模块树">
          <Blocks size={20} />
        </button>
        <button type="button" aria-label="检索仓库">
          <Database size={20} />
        </button>
        <button type="button" aria-label="工作流">
          <Workflow size={20} />
        </button>
        <span className="activity-spacer" />
        <button type="button" aria-label="设置">
          <Settings2 size={20} />
        </button>
      </aside>

      <aside className="explorer-pane">
        <div className="pane-heading">
          <span>{workspaceView === 'repository' ? '历史仓划分' : workspaceView === 'target' ? '目标模块树' : '当前流程'}</span>
          <PanelLeftClose size={14} />
        </div>
        <nav className="workspace-switcher" aria-label="模块工作区切换">
          <button
            type="button"
            className={workspaceView === 'target' ? 'is-active' : ''}
            aria-pressed={workspaceView === 'target'}
            onClick={() => setWorkspaceView('target')}
          >
            <Blocks size={13} /> 目标工作区 <small>01B</small>
          </button>
          <button
            type="button"
            className={workspaceView === 'repository' ? 'is-active' : ''}
            aria-pressed={workspaceView === 'repository'}
            onClick={() => setWorkspaceView('repository')}
          >
            <Database size={13} /> 历史仓 <small>01A</small>
          </button>
          {workspaceView !== null && state.stage !== 'target' ? (
            <button type="button" onClick={() => setWorkspaceView(null)}>
              <Workflow size={13} /> 返回当前流程
            </button>
          ) : null}
        </nav>
        <div className="explorer-scope">
          <span>{workspaceView === 'repository' ? 'HISTORY REPOSITORY' : workspaceView === 'target' ? 'TARGET WORKSPACE' : 'WORKFLOW CONTEXT'}</span>
          <strong>{workspaceView === 'repository' ? `${repositoryModules.length} MODULES` : moduleTree.name}</strong>
        </div>
        {workspaceView === 'repository' ? (
          <div className="repository-explorer">
            {repositoryModules.map((module) => (
              <div key={module.id}>
                <Boxes size={14} />
                <span><strong>{module.name}</strong><small>{module.sourceFiles.length} files · {module.language}</small></span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="target-explorer-tools">
              <label className="explorer-search">
                <Search size={12} />
                <input
                  value={targetQuery}
                  onChange={(event) => setTargetQuery(event.target.value)}
                  placeholder="搜索文件、类或方法"
                  aria-label="搜索目标工作区"
                />
              </label>
              <div className="explorer-status-filters" aria-label="侧边栏实现状态筛选">
                {moduleFilters.map((filter) => (
                  <button
                    type="button"
                    className={targetFilter === filter.id ? 'is-active' : ''}
                    aria-pressed={targetFilter === filter.id}
                    key={filter.id}
                    onClick={() => setTargetFilter(filter.id)}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>
            <ModuleTree
              root={moduleTree}
              selectedId={state.target?.id ?? null}
              onSelect={handleTargetSelect}
              query={targetQuery}
              statusFilter={targetFilter}
            />
          </>
        )}
        <div className="explorer-note">
          {workspaceView === 'repository'
            ? '模块边界来自静态符号与依赖证据；Agent 摘要不会直接修改历史代码仓。'
            : workspaceView === 'target'
              ? '目标工作区是主视图；历史仓可随时切换查看，且不会清空当前流程。'
              : '切换模块工作区只改变查看内容；选择新目标时才会重置下游结果。'}
        </div>
      </aside>

      <main className="workspace-pane">
        <WorkflowRail stage={state.stage} />
        {state.error ? <div className="error-banner">{state.error}</div> : null}

        <div className="workspace-content">
          {workspaceView === 'repository' ? (
            <RepositoryModulePlan
              modules={repositoryModules}
              sourceLabel={searchProvider === 'SeekDB' ? 'SeekDB code corpus' : 'Mock catalog'}
              confirmLabel="返回目标工作区"
              onConfirm={() => setWorkspaceView('target')}
            />
          ) : null}

          {workspaceView === 'target' ? (
            <TargetModulePartition
              root={moduleTree}
              selected={state.target}
              confirmLabel={state.stage === 'target' ? undefined : '返回当前工作流阶段'}
              onConfirm={handleTargetConfirm}
            />
          ) : null}

          {workspaceView === null && state.stage === 'requirement' ? (
            <RequirementPanel
              state={state}
              dispatch={dispatch}
              onSearch={handleSearch}
              searchProvider={searchProvider}
            />
          ) : null}

          {workspaceView === null && state.stage === 'candidates' ? (
            <div className="candidate-stage">
              <CandidateBrowser
                candidates={state.candidates}
                selectedId={state.selectedCandidateId}
                sourceLabel={`${searchProvider} Search Port`}
                onSelect={(candidateId) =>
                  dispatch({ type: 'SELECT_CANDIDATE', candidateId })
                }
              />
              <SelectionFooter
                state={state}
                dispatch={dispatch}
                onAdapt={handleAdapt}
                adaptationProvider={adaptationProvider}
              />
            </div>
          ) : null}

          {workspaceView === null && state.stage === 'adaptation' ? (
            <div className="processing-state">
              <div className="processing-rings" aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <div className="eyebrow">CodeAdaptationPort</div>
              <h1>正在生成接口映射与目标实现</h1>
              <p>
                策略：{state.strategy} · {candidate?.language} → {state.target?.language}
              </p>
              <div className="processing-log">
                <span>{adaptationProvider} 正在翻译源实现</span>
                <span>临时 C# skeleton 编译与自动修复</span>
                <span>生成工作区补丁预览</span>
              </div>
            </div>
          ) : null}

          {workspaceView === null && (state.stage === 'patch' || state.stage === 'complete') && state.adaptation ? (
            <PatchReview
              result={state.adaptation}
              applyResult={state.applyResult}
              applying={state.pending === 'apply'}
              onApply={handleApply}
              onBack={() => dispatch({ type: 'RETURN_TO_CANDIDATES' })}
            />
          ) : null}
        </div>
      </main>

      <Inspector
        state={state}
        searchProvider={searchProvider}
        adaptationProvider={adaptationProvider}
        repositoryModuleCount={repositoryModules.length}
        workspaceView={workspaceView}
      />

      <footer className="statusbar">
        <span>{moduleTree.name} · main</span>
        <span>检索器：{searchProvider} · 混合</span>
        <span>适配器：{adaptationProvider}</span>
        <span>目标：{state.target?.language ?? '未选择'}</span>
        <span className="statusbar-spacer" />
        <span>Ports 3/3 ready</span>
      </footer>
    </div>
  );
}
