import { test, expect } from 'bun:test';
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createState, createSection } from './fixture';
import { atomic, assertUnchanged, checkpoint, confine, destination, hash, listCheckpoints, load, metadata, recover, save, transition } from '../src/state';

test('empty destination differs from cancellation and resolves file paths', () => {
  expect(destination('', '/tmp/spec')).toEqual({ workspace: '/tmp/spec', tex: '/tmp/spec/spec.tex' });
  expect(destination('nested/custom.tex', '/tmp/spec')).toEqual({ workspace: '/tmp/spec/nested', tex: '/tmp/spec/nested/custom.tex' });
});
test('approval cannot follow drafting or compilation', async () => {
  const state = await createState();
  try {
    transition(state, 'DRAFTING');
    expect(() => transition(state, 'APPROVED')).toThrow();
    transition(state, 'COMPILING');
    expect(() => transition(state, 'APPROVED')).toThrow();
    transition(state, 'REVIEW');
    transition(state, 'APPROVED');
    transition(state, 'READY');
    expect(state.phase).toBe('READY');
  } finally { await rm(state.workspace, { recursive: true }); }
});
test('interruption preserves saved candidate and external edits are never overwritten', async () => {
  const state = await createState();
  try {
    state.pendingSection = createSection();
    state.phase = 'COMPILING';
    await save(state);
    const restored = await load(state.workspace);
    expect(restored.pendingSection?.latex).toBe('A section requires explicit approval.');
    expect(restored.phase).toBe('ERROR');
    const manual = state.source.replace('Technical specification', 'Manual document');
    await atomic(state.workspace, state.tex, manual);
    await expect(assertUnchanged(restored)).rejects.toThrow('External');
    await load(state.workspace);
    expect(await readFile(state.tex, 'utf8')).toBe(manual);
  } finally { await rm(state.workspace, { recursive: true }); }
});
test('atomic checkpoint restores source and prevents traversal and symlink writes', async () => {
  const state = await createState();
  try {
    await checkpoint(state);
    const [selected] = await listCheckpoints(state);
    await atomic(state.workspace, state.tex, 'external edits');
    const restored = await recover(state.workspace, selected);
    expect(await readFile(state.tex, 'utf8')).toBe(state.source);
    expect(restored.sourceHash).toBe(hash(state.source));
    await expect(confine(state.workspace, join(state.workspace, '..', 'outside'))).rejects.toThrow();
    await symlink('/tmp', join(state.workspace, 'linked'));
    await expect(atomic(state.workspace, join(state.workspace, 'linked', 'escape'), 'unsafe')).rejects.toThrow('Symbolic');
    await expect(recover(state.workspace, '../../state')).rejects.toThrow();
  } finally { await rm(state.workspace, { recursive: true }); }
});
test('commit manifest repairs interrupted source publication', async () => {
  const state = await createState();
  try {
    const original = state.sourceHash;
    state.source += '\n';
    state.previousHash = original;
    state.sourceHash = hash(state.source);
    state.pendingPublication = true;
    await save(state);
    await load(state.workspace);
    expect(await readFile(state.tex, 'utf8')).toBe(state.source);
    const manifest = JSON.parse(await readFile(metadata(state, 'state.json'), 'utf8'));
    expect(manifest.sourceHash).toBe(hash(state.source));
    expect(manifest.pendingPublication).toBeUndefined();
    await atomic(state.workspace, state.tex, state.source.slice(0, -1));
    await load(state.workspace);
    expect(await readFile(state.tex, 'utf8')).toBe(state.source.slice(0, -1));
  } finally { await rm(state.workspace, { recursive: true }); }
});
