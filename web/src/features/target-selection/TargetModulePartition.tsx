import { useMemo, useState } from 'react';
import {
  Box,
  Boxes,
  Braces,
  CheckCircle2,
  Circle,
  FileCode2,
  Search,
} from 'lucide-react';
import type { ModuleNode, ModuleTarget } from '@forexplore/contracts';
import { ModuleTree, type ModuleImplementationFilter } from './ModuleTree';

interface TreeStats {
  files: number;
  types: number;
  methods: number;
  implemented: number;
  unimplemented: number;
}

function treeStats(root: ModuleNode): TreeStats {
  const result: TreeStats = { files: 0, types: 0, methods: 0, implemented: 0, unimplemented: 0 };
  function visit(node: ModuleNode) {
    if (node.kind === 'file') result.files += 1;
    if (node.kind === 'class' || node.kind === 'record' || node.kind === 'interface') result.types += 1;
    if (node.kind === 'function') result.methods += 1;
    if (node.kind === 'class' || node.kind === 'function') {
      if (node.implementationStatus === 'unimplemented') result.unimplemented += 1;
      else result.implemented += 1;
    }
    node.children?.forEach(visit);
  }
  visit(root);
  return result;
}

function functionalModuleCount(root: ModuleNode): number {
  const source = root.children?.find((node) => node.kind === 'folder' && node.name.toLowerCase() === 'src');
  if (!source) return root.children?.filter((node) => node.kind === 'folder').length ?? 0;
  const folders = source.children?.filter((node) => node.kind === 'folder').length ?? 0;
  const rootSourceFiles = source.children?.filter((node) => node.kind === 'file' && node.children?.length).length ?? 0;
  return folders + rootSourceFiles;
}

function owningModule(target: ModuleTarget): string {
  const parts = target.path.split('/');
  const srcIndex = parts.indexOf('src');
  return parts[srcIndex + 1] ?? parts[0] ?? 'workspace';
}

const filters: Array<{ id: ModuleImplementationFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'implemented', label: '已完成' },
  { id: 'unimplemented', label: '未完成' },
];

export function TargetModulePartition({
  root,
  selected,
  onSelect,
  confirmLabel,
  onConfirm,
}: {
  root: ModuleNode;
  selected: ModuleTarget | null;
  onSelect: (target: ModuleTarget) => void;
  confirmLabel?: string;
  onConfirm: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ModuleImplementationFilter>('all');
  const stats = useMemo(() => treeStats(root), [root]);
  const symbolTotal = stats.implemented + stats.unimplemented;
  const completion = symbolTotal === 0 ? 0 : Math.round((stats.implemented / symbolTotal) * 100);

  return (
    <div className="partition-page target-partition">
      <header className="partition-heading target-partition-heading">
        <div>
          <div className="partition-kicker"><span>01B</span> 目标工作区模块划分</div>
          <h1>识别目标工程骨架与实现状态</h1>
          <p>沿用 01A 的模块逻辑组织当前待处理工作区，并将 module / class / method 状态绑定到检索目标。</p>
        </div>
        <label className="partition-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索模块、文件、类或方法"
            aria-label="搜索目标工作区"
          />
          <kbd>⌘K</kbd>
        </label>
      </header>

      <div className="target-toolbar">
        <div className="status-filters" aria-label="实现状态筛选">
          <span>状态筛选：</span>
          {filters.map((item) => (
            <button
              type="button"
              className={filter === item.id ? 'is-active' : ''}
              aria-pressed={filter === item.id}
              key={item.id}
              onClick={() => setFilter(item.id)}
            >
              {item.id === 'implemented' ? <CheckCircle2 size={12} /> : item.id === 'unimplemented' ? <Circle size={12} /> : null}
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <section className="partition-metrics target-metrics" aria-label="目标工作区统计">
        <div><Boxes size={16} /><span>模块<strong>{functionalModuleCount(root)}</strong></span></div>
        <div><FileCode2 size={16} /><span>文件<strong>{stats.files}</strong></span></div>
        <div><Box size={16} /><span>类 / 接口<strong>{stats.types}</strong></span></div>
        <div><Braces size={16} /><span>方法<strong>{stats.methods}</strong></span></div>
        <div className="metric-complete"><CheckCircle2 size={16} /><span>已完成<strong>{stats.implemented} <small>({completion}%)</small></strong></span></div>
        <div className="metric-incomplete"><Circle size={16} /><span>未完成<strong>{stats.unimplemented} <small>({100 - completion}%)</small></strong></span></div>
      </section>

      <div className="target-partition-grid">
        <section className="target-tree-panel">
          <div className="target-tree-columns"><span>目标工作区</span><span>类型</span><span>实现状态</span></div>
          <ModuleTree
            root={root}
            selectedId={selected?.id ?? null}
            onSelect={onSelect}
            query={query}
            statusFilter={filter}
            showStatus
          />
        </section>

        <aside className="target-detail-panel">
          <div className="partition-panel-heading"><span>检索目标</span><small>选择 class / method</small></div>
          {selected ? (
            <>
              <div className="target-detail-title">
                <span className="target-detail-icon">{selected.kind === 'class' ? <Box size={17} /> : <Braces size={17} />}</span>
                <div>
                  <strong>{selected.name}</strong>
                  <small>{selected.kind === 'class' ? '类' : '方法'} · {selected.implementationStatus === 'unimplemented' ? '未完成' : '已完成'}</small>
                </div>
              </div>
              <dl className="target-detail-fields">
                <div><dt>所属类 / 文件</dt><dd>{selected.path.split('/').at(-1)}</dd></div>
                <div><dt>所属模块</dt><dd>{owningModule(selected)} 模块</dd></div>
                <div><dt>语言</dt><dd>{selected.language}</dd></div>
                <div><dt>源码位置</dt><dd>{selected.path}:{selected.line ?? 1}</dd></div>
              </dl>
              <div className="target-signature"><span>目标契约</span><code>{selected.signature}</code></div>
              {selected.documentation ? <p className="target-detail-doc">{selected.documentation}</p> : null}
              <div className="implementation-breakdown">
                <span>实现状态统计</span>
                <div><CheckCircle2 size={13} /><strong>已完成</strong><em>{selected.implementationStatus === 'unimplemented' ? 0 : 1}</em></div>
                <div><Circle size={13} /><strong>未完成</strong><em>{selected.implementationStatus === 'unimplemented' ? 1 : 0}</em></div>
              </div>
            </>
          ) : (
            <div className="target-detail-empty"><Boxes size={30} /><strong>选择一个目标符号</strong><span>模块与文件用于浏览；class 或 method 可进入候选检索。</span></div>
          )}
          <button type="button" className="button-primary partition-next" disabled={!selected} onClick={onConfirm}>
            {selected ? confirmLabel ?? `使用 ${selected.name} 开始候选检索` : '请选择 class 或 method'}
          </button>
        </aside>
      </div>
    </div>
  );
}
