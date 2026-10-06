import type { ExtensionContext, ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { mkdir, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { destination, exists, metadata, save, load, confine, hash } from './state';
import type { SpecState } from './state';
import { scaffold } from './document';

export function announce(pi: ExtensionAPI, text: string) { pi.sendMessage({ customType: 'master-document-spec', display: true, content: text }); }
export async function selectDestination(ctx: ExtensionContext) {
  const answer = await ctx.ui.input('Where should the technical specification be created?', 'Empty answer uses the active working directory');
  if (answer === undefined) return;
  let target = destination(answer, ctx.cwd);
  if (!await exists(target.workspace)) {
    if (!await ctx.ui.confirm('Create directory?', target.workspace)) return;
    await mkdir(target.workspace, { recursive: true, mode: 0o700 });
  }
  const root = await realpath(target.workspace);
  target = { workspace: root, tex: join(root, target.tex.split('/').at(-1)!) };
  if (await exists(target.tex) || await exists(join(root, 'spec.tex')) || await exists(join(root, 'spec.pdf')) || await exists(join(root, '.master-document-spec', 'state.json'))) {
    const selection = await ctx.ui.select('A specification already exists here', ['Resume', 'Create separately named document', 'Cancel']);
    if (selection === 'Resume') return { state: await load(root), created: false };
    if (selection !== 'Create separately named document') return;
    const name = await ctx.ui.input('Name the separate document directory');
    if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === '..') return;
    target = destination(name, root);
    if (await exists(target.workspace)) throw new Error('The separate document directory already exists.');
    await mkdir(target.workspace, { mode: 0o700 });
  }
  const title = target.workspace.split('/').at(-1)?.replace(/[-_]/g, ' ') || 'Technical specification';
  const state: SpecState = { schema: 1, workspace: target.workspace, tex: target.tex, title, author: '', language: 'english', paper: 'a4paper', format: 'detailed', version: '1.0', date: new Date().toISOString().slice(0, 10), phase: 'INITIALIZING', sections: [], source: '', sourceHash: '', generation: 0, updatedAt: new Date().toISOString() };
  state.source = await scaffold(state);
  state.sourceHash = hash(state.source);
  await confine(state.workspace, state.tex);
  const sourceFile = await open(state.tex, 'wx', 0o600);
  try { await sourceFile.writeFile(state.source); await sourceFile.sync(); } finally { await sourceFile.close(); }
  await mkdir(join(state.workspace, 'assets'), { recursive: true, mode: 0o700 });
  for (const name of ['checkpoints', 'builds', 'previews', 'logs']) {
    await confine(state.workspace, metadata(state, name));
    await mkdir(metadata(state, name), { recursive: true, mode: 0o700 });
  }
  await save(state);
  return { state, created: true };
}
export async function findWorkspace(ctx: ExtensionContext, workspace?: string) {
  if (workspace) return realpath(destination(workspace, ctx.cwd).workspace);
  const saved = ctx.sessionManager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'master-document-spec-state');
  const latest = saved.at(-1);
  if (latest?.type === 'custom' && latest.data && typeof latest.data === 'object' && 'workspace' in latest.data && typeof latest.data.workspace === 'string') return realpath(latest.data.workspace);
  let root = await realpath(ctx.cwd);
  while (true) {
    if (await exists(join(root, '.master-document-spec', 'state.json')) || await exists(join(root, '.master-document-spec', 'checkpoints'))) return root;
    const parent = await realpath(join(root, '..'));
    if (parent === root) break;
    root = parent;
  }
  throw new Error('No active specification found. Use /mdspec resume <directory>.');
}
export async function findActive(ctx: ExtensionContext, workspace?: string) {
  const state = await load(await findWorkspace(ctx, workspace));
  const saved = ctx.sessionManager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'master-document-spec-state');
  const latest = saved.at(-1);
  if (latest?.type === 'custom' && latest.data && typeof latest.data === 'object' && 'workspace' in latest.data && latest.data.workspace === state.workspace && 'sourceHash' in latest.data && latest.data.sourceHash !== state.sourceHash) ctx.ui.notify('Session metadata differs from durable disk state. The verified disk state is restored.', 'warning');
  return state;
}
export function sessionState(pi: ExtensionAPI, state: SpecState) {
  pi.appendEntry('master-document-spec-state', { workspace: state.workspace, tex: state.tex, sourceHash: state.sourceHash, generation: state.generation, phase: state.phase, currentId: state.currentId });
}
export async function readInstructions(ctx: ExtensionContext, state: SpecState, title: string, prefill?: string) {
  const instructions = await ctx.ui.editor(title, prefill, undefined, { promptStyle: true });
  if (instructions === undefined) return;
  if (!instructions.trim()) throw new Error('Describe the section before drafting it.');
  state.pendingInstructions = instructions;
  await save(state);
  return instructions;
}
