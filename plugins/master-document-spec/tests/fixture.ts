import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffold } from '../src/document';
import { atomic, hash, save } from '../src/state';
import type { SpecState, Section } from '../src/state';

export async function createState() {
  const workspace = await mkdtemp(join(tmpdir(), 'mdspec-test-'));
  const state: SpecState = { schema: 1, workspace, tex: join(workspace, 'spec.tex'), title: 'Technical specification', author: '', language: 'english', paper: 'a4paper', format: 'detailed', version: '1.0', date: '2026-10-01', phase: 'READY', sections: [], source: '', sourceHash: '', generation: 0, updatedAt: '2026-10-01' };
  state.source = await scaffold(state);
  state.sourceHash = hash(state.source);
  await atomic(workspace, state.tex, state.source);
  await mkdir(join(workspace, 'assets'));
  await save(state);
  return state;
}
export function createSection(id = 's1'): Section {
  return { id, isAppendix: false, heading: 'Approval & safety', latex: 'A section requires explicit approval.', instructions: 'Approval behavior', revision: 1, approved: false, needsReview: false, dependencies: [], assumptions: [], questions: [], requirements: [], decisions: [], glossary: {}, references: [], history: [], pages: [] };
}
