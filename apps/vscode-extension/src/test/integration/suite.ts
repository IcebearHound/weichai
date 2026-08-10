import * as assert from 'node:assert';
import * as vscode from 'vscode';
const FIXTURE_FILE = process.env.FOREXPLORE_TEST_FIXTURE;
const FIXTURE_WORKSPACE = process.env.FOREXPLORE_TEST_WORKSPACE;

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15_000,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms.`);
}

async function openFixtureWithSelection(): Promise<void> {
  if (!FIXTURE_FILE) throw new Error('FOREXPLORE_TEST_FIXTURE env var is required.');
  if (!FIXTURE_WORKSPACE) throw new Error('FOREXPLORE_TEST_WORKSPACE env var is required.');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(FIXTURE_FILE));
  const editor = await vscode.window.showTextDocument(document);
  const methodOffset = document.getText().indexOf('public async Task<Quote> GetQuoteAsync');
  assert.ok(methodOffset >= 0, 'C# demo fixture must contain GetQuoteAsync');
  const fullRange = new vscode.Range(
    document.positionAt(methodOffset),
    document.positionAt(Math.min(document.getText().length, methodOffset + 360)),
  );
  editor.selection = new vscode.Selection(fullRange.start, fullRange.end);
  assert.ok(
    vscode.workspace.getWorkspaceFolder(document.uri),
    'C# fixture must be inside the launched workspace folder',
  );
}

function findTranslationTab(): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (tab) =>
        tab.input instanceof vscode.TabInputWebview &&
        tab.input.viewType === 'forexplore.translation',
    );
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('forexplore.forexplore-vscode');
  assert.ok(extension, 'extension forexplore.forexplore-vscode must be activated');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'forexplore.startTranslation',
    'forexplore.showPanel',
    'forexplore.checkRepositories',
    'forexplore.reindex',
    'forexplore.restoreLastCheckpoint',
  ]) {
    assert.ok(commands.includes(command), `command ${command} must be registered`);
  }

  await openFixtureWithSelection();
  await vscode.commands.executeCommand('forexplore.startTranslation');
  await waitFor(() => findTranslationTab() !== undefined);
  assert.ok(findTranslationTab(), 'translation webview panel must be opened');

  // Re-running with an active selection must reuse the same panel.
  await vscode.commands.executeCommand('forexplore.startTranslation');
  const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  const panels = tabs.filter(
    (tab) =>
      tab.input instanceof vscode.TabInputWebview &&
      tab.input.viewType === 'forexplore.translation',
  );
  assert.strictEqual(panels.length, 1, 'translation panel must be reused, not duplicated');
}
