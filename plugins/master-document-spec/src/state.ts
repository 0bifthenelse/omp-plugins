import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, open, realpath, lstat, readdir } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, dirname } from 'node:path';
import { z } from 'zod';
import { renderDocument } from './markdown';

export const phases = ['INITIALIZING', 'READY', 'DRAFTING', 'COMPILING', 'REVIEW', 'APPROVED', 'REVISING', 'PAUSED', 'FINALIZING', 'COMPLETE', 'ERROR'] as const;
const requirement = z.object({ id: z.string().regex(/^REQ-[A-Za-z0-9-]+$/), text: z.string(), acceptance: z.array(z.string()), references: z.array(z.string()) });
const section = z.object({ id: z.string().regex(/^s[0-9]+$/), isAppendix: z.boolean().default(false), heading: z.string(), latex: z.string(), instructions: z.string(), revision: z.number().int().nonnegative(), approved: z.boolean(), needsReview: z.boolean(), dependencies: z.array(z.string()), assumptions: z.array(z.string()), questions: z.array(z.string()), requirements: z.array(requirement), decisions: z.array(z.string()), glossary: z.record(z.string(), z.string()), references: z.array(z.object({ source: z.string(), provenance: z.string(), verified: z.boolean() })), history: z.array(z.object({ revision: z.number(), latex: z.string(), heading: z.string(), approved: z.boolean(), at: z.string() })), pages: z.array(z.number().int().positive()) });
export const stateSchema = z.object({
  schema: z.literal(1), workspace: z.string(), tex: z.string(), title: z.string(), author: z.string(),
  language: z.enum(['english', 'french']), paper: z.enum(['a4paper', 'letterpaper']), format: z.enum(['compact', 'detailed']),
  version: z.string(), date: z.string(), phase: z.enum(phases), pausedFrom: z.enum(phases).optional(),
  sections: z.array(section), currentId: z.string().optional(), pendingSection: section.optional(), pendingSummary: z.string().optional(),
  pendingInstructions: z.string().optional(), failedResponse: z.string().optional(), source: z.string(),
  sourceHash: z.string(), previousHash: z.string().optional(), pendingPublication: z.boolean().optional(), generation: z.number().int().nonnegative(),
  build: z.object({ directory: z.string(), pdfHash: z.string(), pages: z.number().int().positive(), warnings: z.array(z.string()) }).optional(),
  error: z.string().optional(), updatedAt: z.string(),
});
export type SpecState = z.infer<typeof stateSchema>;
export type Section = z.infer<typeof section>;
const transitions: Record<SpecState['phase'], readonly SpecState['phase'][]> = {
  INITIALIZING: ['COMPILING', 'ERROR', 'PAUSED'], READY: ['DRAFTING', 'REVISING', 'FINALIZING', 'PAUSED', 'ERROR'], DRAFTING: ['COMPILING', 'ERROR', 'PAUSED'], COMPILING: ['READY', 'REVIEW', 'ERROR', 'PAUSED'], REVIEW: ['APPROVED', 'REVISING', 'FINALIZING', 'PAUSED', 'ERROR'], APPROVED: ['READY', 'PAUSED', 'ERROR'], REVISING: ['COMPILING', 'REVIEW', 'ERROR', 'PAUSED'], PAUSED: ['INITIALIZING', 'READY', 'DRAFTING', 'COMPILING', 'REVIEW', 'APPROVED', 'REVISING', 'FINALIZING', 'ERROR', 'COMPLETE'], FINALIZING: ['COMPILING', 'READY', 'REVIEW', 'COMPLETE', 'PAUSED', 'ERROR'], COMPLETE: ['READY', 'REVISING', 'PAUSED'], ERROR: ['INITIALIZING', 'READY', 'REVIEW', 'DRAFTING', 'REVISING', 'COMPILING', 'FINALIZING', 'PAUSED'],
};
export function transition(state: SpecState, next: SpecState['phase']) {
  if (state.phase !== next && !transitions[state.phase].includes(next)) throw new Error(`Invalid transition: ${state.phase} to ${next}`);
  state.phase = next;
}
export function hash(source: string | Buffer) { return createHash('sha256').update(source).digest('hex'); }
export function metadata(state: Pick<SpecState, 'workspace'>, ...parts: string[]) { return join(state.workspace, '.master-document-spec', ...parts); }
export function markdownPath(state: Pick<SpecState, 'tex'>) { return state.tex.replace(/\.tex$/, '.md'); }
async function writeMarkdown(state: SpecState) {
  const markdown = renderDocument(state, state.sections).markdown;
  const path = markdownPath(state);
  await confine(state.workspace, path);
  if (!await exists(path) || await readFile(path, 'utf8') !== markdown) await atomic(state.workspace, path, markdown);
}
export function destination(answer: string, cwd: string) {
  const requested = resolve(cwd, answer.trim().replace(/^~(?=\/|$)/, process.env.HOME ?? ''));
  return requested.endsWith('.tex') ? { workspace: dirname(requested), tex: requested } : { workspace: requested, tex: join(requested, 'spec.tex') };
}
export async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export async function confine(workspace: string, path: string) {
  const root = await realpath(workspace);
  const rel = relative(root, resolve(path));
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path escapes the document workspace.');
  let cursor = root;
  for (const part of rel.split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    if (await exists(cursor) && (await lstat(cursor)).isSymbolicLink()) throw new Error(`Symbolic links are not allowed in managed paths: ${cursor}`);
  }
}
export async function atomic(workspace: string, path: string, content: string | Buffer) {
  await confine(workspace, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staging = `${path}.${randomUUID()}.pending`;
  const file = await open(staging, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  await rename(staging, path);
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function save(state: SpecState) {
  state.generation++;
  state.updatedAt = new Date().toISOString();
  await atomic(state.workspace, metadata(state, 'state.json'), JSON.stringify(stateSchema.parse(state), null, 2));
}
export async function assertUnchanged(state: SpecState) {
  await confine(state.workspace, state.tex);
  if (hash(await readFile(state.tex)) !== state.sourceHash) throw new Error('External LaTeX edits detected. Use /mdspec reconcile before writing.');
}
export async function publish(state: SpecState, source: string) {
  await assertUnchanged(state);
  state.previousHash = state.sourceHash;
  state.source = source;
  state.sourceHash = hash(source);
  state.pendingPublication = true;
  await save(state);
  await atomic(state.workspace, state.tex, source);
  await writeMarkdown(state);
  if (state.build) await atomic(state.workspace, join(state.workspace, 'spec.pdf'), await readFile(join(state.build.directory, 'spec.pdf')));
  state.pendingPublication = undefined;
  await save(state);
}
export async function load(workspace: string): Promise<SpecState> {
  const root = await realpath(workspace);
  await confine(root, join(root, '.master-document-spec', 'state.json'));
  const state = stateSchema.parse(JSON.parse(await readFile(join(root, '.master-document-spec', 'state.json'), 'utf8')));
  if (state.workspace !== root || dirname(state.tex) !== root) throw new Error('State location disagrees with its workspace.');
  await confine(root, state.tex);
  if (hash(state.source) !== state.sourceHash) throw new Error('Stored source checksum failed. Restore an approved checkpoint.');
  const diskHash = hash(await readFile(state.tex));
  const isInterruptedPublication = state.pendingPublication === true && diskHash === state.previousHash;
  if (diskHash !== state.sourceHash && isInterruptedPublication) await atomic(root, state.tex, state.source);
  if (state.build) {
    await confine(root, state.build.directory);
    const pdf = await readFile(join(state.build.directory, 'spec.pdf'));
    if (hash(pdf) !== state.build.pdfHash) throw new Error('Verified PDF checksum failed. Rebuild before approval.');
    const published = join(root, 'spec.pdf');
    await confine(root, published);
    if ((diskHash === state.sourceHash || isInterruptedPublication) && (!await exists(published) || hash(await readFile(published)) !== state.build.pdfHash)) await atomic(root, published, pdf);
  }
  if (diskHash === state.sourceHash || isInterruptedPublication) await writeMarkdown(state);
  if (state.pendingPublication && (diskHash === state.sourceHash || isInterruptedPublication)) { state.pendingPublication = undefined; await save(state); }
  if (['DRAFTING', 'REVISING', 'COMPILING', 'FINALIZING', 'INITIALIZING'].includes(state.phase)) { state.error = `Interrupted ${state.phase.toLowerCase()}. Saved instructions and last verified source remain available.`; state.phase = state.currentId ? 'REVIEW' : state.build ? 'READY' : 'ERROR'; await save(state); }
  return state;
}
export async function checkpoint(state: SpecState) {
  await assertUnchanged(state);
  const directory = metadata(state, 'checkpoints', `${String(state.generation).padStart(8, '0')}-${randomUUID()}`);
  await atomic(state.workspace, join(directory, 'spec.tex'), state.source);
  await atomic(state.workspace, join(directory, 'spec.md'), renderDocument(state, state.sections).markdown);
  if (state.build) await atomic(state.workspace, join(directory, 'spec.pdf'), await readFile(join(state.build.directory, 'spec.pdf')));
  const snapshot = structuredClone(state);
  if (snapshot.build) snapshot.build.directory = directory;
  await atomic(state.workspace, join(directory, 'state.json'), JSON.stringify(snapshot, null, 2));
}
export async function recover(workspace: string, selected: string) {
  const root = await realpath(workspace);
  const path = join(root, '.master-document-spec', 'checkpoints', selected, 'state.json');
  await confine(root, path);
  const state = stateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (state.workspace !== root || hash(state.source) !== state.sourceHash) throw new Error('Checkpoint integrity failed.');
  if (dirname(state.tex) !== root) throw new Error('Checkpoint source location is invalid.');
  if (state.build) {
    await confine(root, state.build.directory);
    if (hash(await readFile(join(state.build.directory, 'spec.pdf'))) !== state.build.pdfHash) throw new Error('Checkpoint PDF integrity failed.');
  }
  const backupId = Date.now();
  if (await exists(state.tex)) await atomic(root, metadata(state, 'logs', `before-recovery-${backupId}.tex`), await readFile(state.tex));
  if (await exists(metadata(state, 'state.json'))) await atomic(root, metadata(state, 'logs', `before-recovery-${backupId}.json`), await readFile(metadata(state, 'state.json')));
  await atomic(root, state.tex, state.source);
  await save(state);
  return load(root);
}
export async function lock(workspace: string) {
  const path = join(workspace, '.master-document-spec', 'lock');
  await confine(workspace, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const child = spawn('/usr/bin/flock', ['--nonblock', '--exclusive', '--no-fork', path, '/usr/bin/cat'], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  });
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    let diagnostics = '';
    const timer = setTimeout(() => {
      child.stdin.destroy();
      try { process.kill(-child.pid!, 'SIGTERM'); } catch {}
      reject(new Error('Workspace lock acquisition timed out.'));
    }, 5000);
    child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4096); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.once('data', () => { ready = true; clearTimeout(timer); resolve(); });
    child.once('close', code => {
      clearTimeout(timer);
      if (!ready) reject(new Error(code === 1 ? 'Another document workflow owns this workspace.' : `Kernel file locking failed: ${diagnostics}`));
    });
    child.stdin.write('master-document-spec\\n');
  });
  return async () => { child.stdin.end(); await closed; };
}
export async function listCheckpoints(state: Pick<SpecState, 'workspace'>) {
  const directory = metadata(state, 'checkpoints');
  await confine(state.workspace, directory);
  return await exists(directory) ? (await readdir(directory)).sort().reverse() : [];
}
