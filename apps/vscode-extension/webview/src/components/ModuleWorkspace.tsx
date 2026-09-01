import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  FileCode2,
  FileJson2,
  Folder,
  GitBranch,
  History,
  RefreshCw,
  Search,
  Sparkles,
  Target,
} from 'lucide-react';
import type {
  ModuleExplorerMode,
  ModuleExplorerNode,
  ModuleExplorerPresentation,
  ModuleImplementationStatus,
  ModuleWorkspacePresentation,
} from '../../../src/ui-types';

type StatusFilter = 'all' | 'implemented' | 'unimplemented';

interface ModuleWorkspaceProps {
  explorer: ModuleExplorerPresentation;
  mode: ModuleExplorerMode;
  historyId: string | null;
  currentTargetId: string;
  selectedNodeId: string | null;
  refreshing: boolean;
  onModeChange(mode: ModuleExplorerMode): void;
  onHistoryChange(id: string): void;
  onNodeSelect(node: ModuleExplorerNode): void;
  onTargetSelect(targetId: string): void;
  onRefresh(): void;
  onOpenHistorySettings(): void;
  children: React.ReactNode;
}

export function ModuleWorkspace({
  explorer,
  mode,
  historyId,
  currentTargetId,
  selectedNodeId,
  refreshing,
  onModeChange,
  onHistoryChange,
  onNodeSelect,
  onTargetSelect,
  onRefresh,
  onOpenHistorySettings,
  children,
}: ModuleWorkspaceProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const workspace = activeWorkspace(explorer, mode, historyId);
  const filteredTree = useMemo(
    () => filterTree(workspace.tree, query.trim().toLocaleLowerCase(), status),
    [workspace.tree, query, status],
  );
  const selectedNode = findNode(
    workspace.tree,
    (node) => node.id === selectedNodeId,
  ) ?? findNode(workspace.tree, (node) => node.targetId === currentTargetId);

  return (
    <div className="module-layout">
      <aside className="module-sidebar" aria-label="模块工作区导航">
        <div className="workspace-switch" role="tablist" aria-label="模块数据源">
          <button
            type="button"
            className={mode === 'target' ? 'is-active' : ''}
            onClick={() => onModeChange('target')}
          >
            <Target size={13} />
            目标工作区
            <small>01B</small>
          </button>
          <button
            type="button"
            className={mode === 'history' ? 'is-active' : ''}
            onClick={() => onModeChange('history')}
          >
            <History size={13} />
            历史仓
            <small>01A</small>
          </button>
        </div>

        {mode === 'history' && explorer.history.length > 1 ? (
          <label className="history-picker">
            <span>历史仓库</span>
            <select
              value={workspace.id}
              onChange={(event) => onHistoryChange(event.target.value)}
            >
              {explorer.history.map((repository) => (
                <option key={repository.id} value={repository.id}>{repository.name}</option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="explorer-title-row">
          <div>
            <strong>{workspace.name}</strong>
            <small>{workspace.rootLabel}</small>
          </div>
          <button
            type="button"
            className="icon-button"
            title="重新分析模块树"
            aria-label="重新分析模块树"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw size={13} className={refreshing ? 'is-spinning' : ''} />
          </button>
        </div>

        <label className="module-search">
          <Search size={13} />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模块、文件、类或方法"
          />
        </label>

        <div className="status-filter" aria-label="实现状态筛选">
          {([
            ['all', '全部'],
            ['implemented', '已完成'],
            ['unimplemented', '未完成'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={status === value ? 'is-active' : ''}
              onClick={() => setStatus(value)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="module-tree" role="tree" aria-label={`${workspace.name} 模块树`}>
          {workspace.loading ? (
            <div className="tree-empty">
              <RefreshCw size={15} className="is-spinning" />
              <span>切换到历史仓后正在按需分析模块…</span>
            </div>
          ) : workspace.error ? (
            <div className="tree-empty is-error">
              <AlertTriangle size={15} />
              <span>{workspace.error}</span>
            </div>
          ) : filteredTree.length === 0 ? (
            <div className="tree-empty">没有匹配的模块项</div>
          ) : (
            filteredTree.map((node) => (
              <TreeNode
                key={node.id}
                node={node}
                depth={0}
                currentTargetId={currentTargetId}
                selectedNodeId={selectedNode?.id ?? null}
                onNodeSelect={onNodeSelect}
                onTargetSelect={mode === 'target' ? onTargetSelect : undefined}
              />
            ))
          )}
        </div>

        <div className="tree-legend">
          <span><i className="status-mark is-implemented" />已完成</span>
          <span><i className="status-mark is-unimplemented" />未完成</span>
          <span><i className="status-mark is-unknown" />待确认</span>
        </div>
      </aside>

      <section className="module-main">
        <div className="module-main-scroll">
          {explorer.history.length === 0 ? (
            <section className="history-configuration-prompt" role="status">
              <div className="history-configuration-icon"><History size={17} /></div>
              <div>
                <strong>尚未配置历史仓</strong>
                <span>添加至少一个本地历史代码仓路径，保存后点击左侧刷新按钮即可加载 01A。</span>
              </div>
              <button type="button" className="secondary-action" onClick={onOpenHistorySettings}>
                配置路径
              </button>
            </section>
          ) : null}
          {mode === 'target' ? (
            <TargetOverview workspace={workspace} selectedNode={selectedNode} />
          ) : (
            <HistoryOverview workspace={workspace} selectedNode={selectedNode} />
          )}
          {mode === 'target' ? children : null}
        </div>
      </section>
    </div>
  );
}

interface TreeNodeProps {
  node: ModuleExplorerNode;
  depth: number;
  currentTargetId: string;
  selectedNodeId: string | null;
  onNodeSelect(node: ModuleExplorerNode): void;
  onTargetSelect?: (targetId: string) => void;
}

function TreeNode(props: TreeNodeProps) {
  const { node, depth, currentTargetId, selectedNodeId, onNodeSelect, onTargetSelect } = props;
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const isCurrent = node.targetId === currentTargetId;
  const isSelected = node.id === selectedNodeId;

  function select(): void {
    onNodeSelect(node);
    if (node.targetId && node.targetId !== currentTargetId && onTargetSelect) {
      onTargetSelect(node.targetId);
    }
  }

  return (
    <div className="tree-node" role="treeitem" aria-expanded={hasChildren ? expanded : undefined}>
      <div
        className={`tree-row${isSelected ? ' is-selected' : ''}${isCurrent ? ' is-current-target' : ''}`}
        style={{ paddingLeft: `${6 + depth * 15}px` }}
      >
        <button
          type="button"
          className="tree-toggle"
          aria-label={expanded ? '折叠' : '展开'}
          onClick={() => setExpanded((value) => !value)}
          disabled={!hasChildren}
        >
          {hasChildren ? (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
        </button>
        <button type="button" className="tree-select" onClick={select} title={node.signature ?? node.path}>
          <NodeIcon node={node} />
          <span className="tree-label">{node.name}</span>
          {node.targetId ? <StatusMark status={node.implementationStatus} /> : null}
        </button>
      </div>
      {hasChildren && expanded ? (
        <div role="group">
          {node.children.map((child) => (
            <TreeNode key={child.id} {...props} node={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function NodeIcon({ node }: { node: ModuleExplorerNode }) {
  if (node.kind === 'module') return <Box size={13} className="node-icon is-module" />;
  if (node.kind === 'folder') return <Folder size={13} className="node-icon is-folder" />;
  if (node.kind === 'file') return <FileCode2 size={13} className="node-icon is-file" />;
  return <span className={`symbol-icon is-${node.kind}`}>{symbolLetter(node.kind)}</span>;
}

function StatusMark({ status }: { status?: ModuleImplementationStatus }) {
  return <i className={`status-mark is-${status ?? 'unknown'}`} title={statusLabel(status)} />;
}

function TargetOverview({
  workspace,
  selectedNode,
}: {
  workspace: ModuleWorkspacePresentation;
  selectedNode?: ModuleExplorerNode;
}) {
  return (
    <div className="module-overview">
      <OverviewHeader
        code="01B"
        title="目标工作区模块划分"
        description="识别模块、文件、类与方法，并持续记录实现状态"
        workspace={workspace}
      />
      <StatsGrid workspace={workspace} />
      <NodeDetail node={selectedNode} targetMode />
    </div>
  );
}

function HistoryOverview({
  workspace,
  selectedNode,
}: {
  workspace: ModuleWorkspacePresentation;
  selectedNode?: ModuleExplorerNode;
}) {
  const pipeline = [
    { icon: <Database size={15} />, title: '静态索引', detail: `${workspace.stats.files} 文件 / ${workspace.stats.types + workspace.stats.methods} 符号`, complete: Boolean(workspace.snapshotId) },
    { icon: <GitBranch size={15} />, title: '依赖分析', detail: `${workspace.stats.dependencies} 条依赖证据`, complete: Boolean(workspace.snapshotId) },
    { icon: <Sparkles size={15} />, title: 'Agent 模块划分', detail: `${workspace.stats.modules} 个模块`, complete: workspace.stats.modules > 0 },
    {
      icon: <FileJson2 size={15} />,
      title: 'summary.json',
      detail: workspace.summary.error
        ? '摘要无效'
        : workspace.summary.exists ? `${workspace.summary.moduleCount ?? 0} 个模块摘要` : '尚未生成',
      complete: workspace.summary.exists && !workspace.summary.error,
    },
  ];
  return (
    <div className="module-overview history-overview">
      <OverviewHeader
        code="01A"
        title="历史仓模块划分"
        description="从历史代码静态证据沉淀模块边界与可复用知识"
        workspace={workspace}
      />
      <div className="analysis-pipeline">
        {pipeline.map((step, index) => (
          <div key={step.title} className={`pipeline-step${step.complete ? ' is-complete' : ''}`}>
            <span className="pipeline-number">{index + 1}</span>
            <span className="pipeline-icon">{step.icon}</span>
            <div><strong>{step.title}</strong><small>{step.detail}</small></div>
            {step.complete ? <CheckCircle2 size={14} /> : <span className="pipeline-pending" />}
          </div>
        ))}
      </div>
      <div className="history-grid">
        <NodeDetail node={selectedNode} />
        <section className="card summary-card">
          <div className="card-heading"><span>模块知识摘要</span><FileJson2 size={14} /></div>
          {workspace.summary.error ? (
            <div className="summary-empty is-error">
              <AlertTriangle size={24} />
              <strong>module-summary.json 无法读取</strong>
              <span>{workspace.summary.error}</span>
            </div>
          ) : workspace.summary.exists ? (
            <dl className="compact-definition-list">
              <div><dt>计划</dt><dd>{workspace.summary.planId}</dd></div>
              <div><dt>状态</dt><dd>{workspace.summary.status}</dd></div>
              <div><dt>模块</dt><dd>{workspace.summary.moduleCount}</dd></div>
              <div><dt>执行波次</dt><dd>{workspace.summary.waveCount}</dd></div>
              <div><dt>审批</dt><dd>{workspace.summary.approvalsCurrent ? '当前有效' : '需重新确认'}</dd></div>
            </dl>
          ) : (
            <div className="summary-empty">
              <FileJson2 size={24} />
              <strong>未发现 module-summary.json</strong>
              <span>完成 Agent 模块计划和受信任审批后，由 Host 事务生成。</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function OverviewHeader({
  code,
  title,
  description,
  workspace,
}: {
  code: string;
  title: string;
  description: string;
  workspace: ModuleWorkspacePresentation;
}) {
  return (
    <div className="overview-header">
      <div className="overview-glyph"><Box size={17} /></div>
      <div>
        <h1><span>{code}</span> {title}</h1>
        <p>{description}</p>
      </div>
      <div className="snapshot-meta">
        <span>{workspace.snapshotId ? `快照 ${workspace.snapshotId.slice(0, 12)}` : '无可用快照'}</span>
        {workspace.revision ? <code>{workspace.revision.slice(0, 10)}</code> : null}
      </div>
    </div>
  );
}

function StatsGrid({ workspace }: { workspace: ModuleWorkspacePresentation }) {
  const stats = [
    ['模块', workspace.stats.modules, 'M'],
    ['文件', workspace.stats.files, 'F'],
    ['类 / 类型', workspace.stats.types, 'C'],
    ['方法', workspace.stats.methods, 'ƒ'],
    ['已完成', workspace.stats.implemented, '✓'],
    ['未完成', workspace.stats.unimplemented, '○'],
  ] as const;
  return (
    <div className="module-stats">
      {stats.map(([label, value, glyph]) => (
        <div key={label} className={`stat-card is-${label === '已完成' ? 'done' : label === '未完成' ? 'pending' : 'neutral'}`}>
          <span>{glyph}</span><div><strong>{value}</strong><small>{label}</small></div>
        </div>
      ))}
    </div>
  );
}

function NodeDetail({ node, targetMode = false }: { node?: ModuleExplorerNode; targetMode?: boolean }) {
  return (
    <section className="card node-detail-card">
      <div className="card-heading">
        <span>{targetMode ? '当前目标详情' : '模块项详情'}</span>
        {node?.targetId ? <StatusPill status={node.implementationStatus} /> : null}
      </div>
      {!node ? (
        <p className="muted-copy">从左侧模块树选择一个模块、文件、类或方法查看详情。</p>
      ) : (
        <div className="node-detail">
          <div className="node-detail-title"><NodeIcon node={node} /><strong>{node.name}</strong><small>{kindLabel(node.kind)}</small></div>
          {node.description ? <p>{node.description}</p> : null}
          <dl className="compact-definition-list">
            {node.path ? <div><dt>所属文件</dt><dd><code>{node.path}</code></dd></div> : null}
            {node.language ? <div><dt>语言</dt><dd>{node.language}</dd></div> : null}
            {node.line ? <div><dt>起始行</dt><dd>{node.line}</dd></div> : null}
            {node.children.length ? <div><dt>子项</dt><dd>{node.children.length}</dd></div> : null}
          </dl>
          {node.signature ? <pre className="signature-preview"><code>{node.signature}</code></pre> : null}
          {targetMode && node.targetId ? (
            <p className="target-reset-note">选择不同的类或方法会建立新的 Host 文件快照，并重置下游需求、候选与补丁。</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function StatusPill({ status }: { status?: ModuleImplementationStatus }) {
  return <span className={`status-pill is-${status ?? 'unknown'}`}><StatusMark status={status} />{statusLabel(status)}</span>;
}

function activeWorkspace(
  explorer: ModuleExplorerPresentation,
  mode: ModuleExplorerMode,
  historyId: string | null,
): ModuleWorkspacePresentation {
  if (mode === 'target') return explorer.target;
  return explorer.history.find((repository) => repository.id === historyId) ??
    explorer.history[0] ?? emptyHistoryWorkspace();
}

function emptyHistoryWorkspace(): ModuleWorkspacePresentation {
  return {
    id: 'history:empty',
    mode: 'history',
    name: '未配置历史仓',
    rootLabel: '请在 ForeXplore 设置中配置 repositoryPaths',
    error: '未配置可分析的历史代码仓路径。',
    stats: { modules: 0, files: 0, types: 0, methods: 0, implemented: 0, unimplemented: 0, unknown: 0, dependencies: 0 },
    summary: { exists: false, path: '.forexplore/module-summary.json' },
    tree: [],
  };
}

function filterTree(
  nodes: ModuleExplorerNode[],
  query: string,
  status: StatusFilter,
): ModuleExplorerNode[] {
  return nodes.flatMap((node) => {
    const children = filterTree(node.children, query, status);
    const queryMatch = !query || [node.name, node.path, node.signature]
      .filter(Boolean)
      .some((value) => value?.toLocaleLowerCase().includes(query));
    const statusMatch = status === 'all' || node.implementationStatus === status;
    if ((queryMatch && statusMatch) || children.length > 0) return [{ ...node, children }];
    return [];
  });
}

export function findNode(
  nodes: ModuleExplorerNode[],
  predicate: (node: ModuleExplorerNode) => boolean,
): ModuleExplorerNode | undefined {
  for (const node of nodes) {
    if (predicate(node)) return node;
    const child = findNode(node.children, predicate);
    if (child) return child;
  }
  return undefined;
}

function symbolLetter(kind: ModuleExplorerNode['kind']): string {
  if (['class', 'interface', 'record', 'struct', 'enum'].includes(kind)) return 'C';
  return 'M';
}

function kindLabel(kind: ModuleExplorerNode['kind']): string {
  const labels: Record<ModuleExplorerNode['kind'], string> = {
    module: '模块', folder: '目录', file: '文件', class: '类', interface: '接口', record: '记录',
    struct: '结构', enum: '枚举', method: '方法', constructor: '构造方法', function: '函数',
  };
  return labels[kind];
}

function statusLabel(status?: ModuleImplementationStatus): string {
  if (status === 'implemented') return '已完成';
  if (status === 'unimplemented') return '未完成';
  return '待确认';
}
