import { test, expect } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { compile, run } from '../src/compiler';
import { replaceSection } from '../src/document';
import { approve } from '../src/review';
import { hash, load, publish, listCheckpoints, recover, save } from '../src/state';
import { createState, createSection } from './fixture';

test('real compiler maps pages and failure preserves verified artifacts and approval', async () => {
  const state = await createState();
  try {
    const section = createSection();
    section.latex = 'Explicit approval is required.\\newpage The second page preserves the same section.';
    state.sections = [section];
    const source = replaceSection(state.source, section);
    const result = await compile(state, source, state.sections);
    expect(result.ranges).toEqual([{ id: 's1', pages: [3, 4] }]);
    state.build = result.build;
    section.pages = result.ranges[0].pages;
    state.currentId = section.id;
    state.phase = 'REVIEW';
    await publish(state, source);
    expect(section.approved).toBe(false);
    await approve(state, section);
    expect(section.approved).toBe(true);
    const beforePdf = hash(await readFile(join(state.workspace, 'spec.pdf')));
    await expect(compile(state, source.replace(section.latex, '\\undefinedcommand{broken}'), state.sections)).rejects.toThrow('exited');
    expect(await readFile(state.tex, 'utf8')).toBe(source);
    expect(hash(await readFile(join(state.workspace, 'spec.pdf')))).toBe(beforePdf);
    const restored = await load(state.workspace);
    expect(restored.sections[0].approved).toBe(true);
    const [selected] = await listCheckpoints(state);
    const checkpoint = await recover(state.workspace, selected);
    expect(checkpoint.sections[0].approved).toBe(true);
    expect(checkpoint.build?.pages).toBe(4);
    expect(await readFile(state.tex, 'utf8')).toBe(source);
  } finally { await rm(state.workspace, { recursive: true }); }
}, 120000);

test('abandoned subprocesses terminate on timeout and cancellation', async () => {
  const state = await createState();
  try {
    await expect(run('/usr/bin/sleep', ['30'], state.workspace, undefined, 30)).rejects.toThrow('timeout');
    const controller = new AbortController();
    const pending = run('/usr/bin/sleep', ['30'], state.workspace, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    state.phase = 'COMPILING';
    state.pendingInstructions = 'Preserve the saved section';
    await save(state);
    expect((await load(state.workspace)).pendingInstructions).toBe('Preserve the saved section');
  } finally { await rm(state.workspace, { recursive: true }); }
});
