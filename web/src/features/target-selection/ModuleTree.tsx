import { useMemo, useState } from 'react';
import {
  Box,
  Braces,
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
} from 'lucide-react';
import type { ModuleKind, ModuleNode, ModuleTarget } from '@forexplore/contracts';
import { toModuleTarget } from '@forexplore/workflow-core';

interface ModuleTreeProps {
  root: ModuleNode;
  selectedId: string | null;
  onSelect: (target: ModuleTarget) => void;
  query?: string;
  statusFilter?: ModuleImplementationFilter;
  showStatus?: boolean;
}

export type ModuleImplementationFilter = 'all' | 'implemented' | 'unimplemented';

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function filterTree(
  node: ModuleNode,
  query: string,
  statusFilter: ModuleImplementationFilter,
): ModuleNode | null {
  const searchable = `${node.name} ${node.path} ${node.signature ?? ''}`.toLocaleLowerCase();
  const queryMatches = !query || searchable.includes(query);
  const isTarget = node.kind === 'class' || node.kind === 'function';
  const isImplemented = node.implementationStatus !== 'unimplemented';
  const statusMatches = statusFilter === 'all' ||
    (statusFilter === 'implemented' ? isImplemented : !isImplemented);

  if (queryMatches && statusFilter === 'all') return node;
  const children = node.children
    ?.map((child) => filterTree(child, query, statusFilter))
    .filter((child): child is ModuleNode => child !== null);
  if ((isTarget && queryMatches && statusMatches) || children?.length) {
    return { ...node, children };
  }
  return null;
}

function collectInitialExpandedIds(
  node: ModuleNode,
  result: string[] = [],
  depth = 0,
): string[] {
  if (!node.children?.length || depth > 1) return result;
  result.push(node.id);
  node.children
    .filter((child) => child.kind === 'folder')
    .forEach((child) => collectInitialExpandedIds(child, result, depth + 1));
  return result;
}

function NodeIcon({ node, expanded }: { node: ModuleNode; expanded: boolean }) {
  if (node.kind === 'workspace' || node.kind === 'folder') {
    return expanded ? <FolderOpen size={14} /> : <Folder size={14} />;
  }
  if (node.kind === 'file') return <FileCode2 size={14} />;
  if (node.kind === 'class' || node.kind === 'record') return <Box size={14} />;
  return <Braces size={14} />;
}

const kindLabels: Partial<Record<ModuleKind, string>> = {
  class: 'cls',
  record: 'rec',
  interface: 'ifc',
  function: 'fn',
};

export function ModuleTree({
  root,
  selectedId,
  onSelect,
  query = '',
  statusFilter = 'all',
  showStatus = false,
}: ModuleTreeProps) {
  const initialExpanded = useMemo(() => new Set(collectInitialExpandedIds(root)), [root]);
  const [expanded, setExpanded] = useState(initialExpanded);
  const visibleRoot = useMemo(
    () => filterTree(root, normalized(query), statusFilter),
    [query, root, statusFilter],
  );

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderNode(node: ModuleNode, depth: number) {
    const hasChildren = Boolean(node.children?.length);
    const isExpanded = expanded.has(node.id) || Boolean(query.trim()) || statusFilter !== 'all';
    const target = toModuleTarget(node);
    const isSelectable = Boolean(target);
    const isSelected = selectedId === node.id;

    return (
      <div key={node.id}>
        <button
          type="button"
          className={`tree-row ${isSelectable ? 'is-selectable' : ''} ${
            isSelected ? 'is-selected' : ''
          }`}
          style={{ paddingInlineStart: 8 + depth * 14 }}
          aria-selected={isSelected}
          onClick={() => {
            if (target) onSelect(target);
            if (hasChildren) toggle(node.id);
          }}
        >
          <span
            className="tree-chevron"
            onClick={(event) => {
              if (!hasChildren) return;
              event.stopPropagation();
              toggle(node.id);
            }}
          >
            {hasChildren ? (
              isExpanded ? (
                <ChevronDown size={13} />
              ) : (
                <ChevronRight size={13} />
              )
            ) : null}
          </span>
          <span className={`tree-icon tree-icon-${node.kind}`}>
            <NodeIcon node={node} expanded={isExpanded} />
          </span>
          <span className="tree-label">{node.name}</span>
          {node.implementationStatus === 'unimplemented' ? (
            <span className="tree-status" title="源码中尚未实现">
              todo
            </span>
          ) : null}
          {kindLabels[node.kind] ? <span className="tree-kind">{kindLabels[node.kind]}</span> : null}
          {showStatus && (node.kind === 'class' || node.kind === 'function') ? (
            <span className={`tree-implementation ${node.implementationStatus === 'unimplemented' ? 'is-todo' : ''}`}>
              {node.implementationStatus === 'unimplemented' ? '未完成' : '已完成'}
            </span>
          ) : null}
        </button>
        {hasChildren && isExpanded
          ? node.children?.map((child) => renderNode(child, depth + 1))
          : null}
      </div>
    );
  }

  return (
    <div className={`module-tree ${showStatus ? 'has-status-column' : ''}`}>
      {visibleRoot ? renderNode(visibleRoot, 0) : <div className="tree-empty">没有符合条件的符号</div>}
    </div>
  );
}
