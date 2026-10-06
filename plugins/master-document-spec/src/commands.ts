import type { ExtensionAPI, ExtensionCommandContext } from '@oh-my-pi/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { selectDestination, findWorkspace, findActive, announce, sessionState, readInstructions } from './ui';
import { parseDraft } from './author';
import { draft, reviewSection, chooseSection, pause, finalize, commitCandidate } from './review';
import { compile } from './compiler';
import { preview } from './preview';
import { startActivity, stopActivity } from './activity';
import { scaffold, sectionSource, replaceSection } from './document';
import { validateLatex } from './validation';
import { assertUnchanged, atomic, metadata, markdownPath, hash, lock, save, transition, publish, listCheckpoints, recover } from './state';
import type { SpecState } from './state';

const configurationSchema = z.object({ title: z.string().min(1), author: z.string(), language: z.enum(['english', 'french']), paper: z.enum(['a4paper', 'letterpaper']), format: z.enum(['compact', 'detailed']), version: z.string(), date: z.string() });
const actions: Record<string, true | undefined> = Object.fromEntries(['resume', 'status', 'preview', 'revise', 'finish', 'outline', 'goto', 'configure', 'reconcile', 'recover', 'help'].map(action => [action, true]));

async function reconcile(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: SpecState, signal: AbortSignal) {
  const source = await readFile(state.tex, 'utf8');
  if (hash(source) === state.sourceHash) { announce(pi, 'The canonical source has no external changes.'); return; }
  if (!await ctx.ui.confirm('Reconcile external edits?', 'Keep a backup, validate edited section bodies, compile them and require fresh approval. Preamble and managed headings must remain intact.')) return;
  const candidate = structuredClone(state);
  let reconstructed = state.source;
  let changed = 0;
  for (const section of candidate.sections) {
    const original = sectionSource(section);
    const boundary = `\\label{sec:${section.id}}\n`;
    const prefix = original.slice(0, original.indexOf(boundary) + boundary.length);
    const suffix = original.slice(prefix.length + section.latex.length);
    const start = source.indexOf(prefix);
    const end = source.indexOf(suffix, start + prefix.length);
    if (start < 0 || end < 0) throw new Error('External edits changed a managed heading or boundary. Restore those boundaries and retry.');
    const latex = source.slice(start + prefix.length, end);
    validateLatex(latex);
    if (latex !== section.latex) {
      section.history.push({ revision: section.revision, latex: section.latex, heading: section.heading, approved: section.approved, at: new Date().toISOString() });
      section.latex = latex;
      section.revision++;
      section.approved = false;
      section.needsReview = false;
      candidate.currentId ??= section.id;
      changed++;
    }
    reconstructed = replaceSection(reconstructed, section);
  }
  if (reconstructed !== source || !changed) throw new Error('Reconciliation supports section body edits only. Restore preamble, headings and document framing before retrying.');
  const backupId = Date.now();
  await atomic(state.workspace, metadata(state, 'logs', `external-edit-${backupId}.tex`), source);
  await atomic(state.workspace, metadata(state, 'logs', `before-external-edit-${backupId}.tex`), state.source);
  startActivity(ctx, 'Reconciling', `${changed} edited sections`, 'Compiling external LaTeX edits and regenerating the Markdown mirror');
  const result = await compile(candidate, source, candidate.sections, signal);
  stopActivity(ctx);
  for (const section of candidate.sections) if (section.approved) section.needsReview = true;
  candidate.source = source;
  candidate.sourceHash = hash(source);
  candidate.build = result.build;
  candidate.phase = 'REVIEW';
  candidate.currentId = candidate.sections.find(section => !section.approved)?.id;
  for (const range of result.ranges) candidate.sections.find(section => section.id === range.id)!.pages = range.pages;
  await publish(candidate, source);
  Object.assign(state, candidate);
  sessionState(pi, state);
  announce(pi, `${changed} externally edited sections compiled. Their approval is revoked; unchanged sections retain their text and need impact review.`);
}

async function configure(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: SpecState, signal: AbortSignal) {
  await assertUnchanged(state);
  const answer = await ctx.ui.editor('Document settings: edit JSON', JSON.stringify(configurationSchema.parse(state), null, 2));
  if (answer === undefined) return;
  const configuration = configurationSchema.parse(JSON.parse(answer));
  const candidate = { ...structuredClone(state), ...configuration };
  let source = await scaffold(candidate);
  for (const section of candidate.sections) source = replaceSection(source, section);
  startActivity(ctx, 'Typesetting', configuration.title, 'Applying document settings to LaTeX and Markdown');
  const result = await compile(candidate, source, candidate.sections, signal);
  stopActivity(ctx);
  candidate.build = result.build;
  for (const range of result.ranges) candidate.sections.find(section => section.id === range.id)!.pages = range.pages;
  if (candidate.phase === 'COMPLETE') candidate.phase = 'READY';
  await publish(candidate, source);
  Object.assign(state, candidate);
  sessionState(pi, state);
  preview(pi, state, 'Updated document settings');
}

async function guide(pi: ExtensionAPI, ctx: ExtensionCommandContext, state: SpecState, signal: AbortSignal, hasShownPreview = false) {
  if (state.phase === 'PAUSED') {
    transition(state, state.pausedFrom ?? (state.currentId ? 'REVIEW' : 'READY'));
    state.pausedFrom = undefined;
    await save(state);
  }
  if (state.phase === 'APPROVED') { transition(state, 'READY'); state.currentId = undefined; await save(state); }
  if (state.pendingSection) {
    const selection = await ctx.ui.select('A candidate did not finish compilation', ['Retry saved candidate', 'Edit candidate LaTeX', 'Save and exit']);
    if (!selection || selection === 'Save and exit') { await pause(pi, state); return; }
    const section = structuredClone(state.pendingSection);
    if (selection === 'Edit candidate LaTeX') { const latex = await ctx.ui.editor('Repair candidate LaTeX', section.latex); if (latex === undefined) { await pause(pi, state); return; } section.latex = latex; }
    await commitCandidate(pi, ctx, state, section, state.pendingSummary ?? 'Restored saved candidate', signal);
    hasShownPreview = true;
  } else if (state.failedResponse && state.pendingInstructions) {
    const selection = await ctx.ui.select('The model response needs repair', ['Retry saved instructions', 'Edit saved response JSON', 'Save and exit']);
    if (!selection || selection === 'Save and exit') { await pause(pi, state); return; }
    const existing = state.sections.find(section => section.id === state.currentId);
    if (selection === 'Retry saved instructions') {
      state.phase = existing ? 'REVIEW' : 'READY';
      await draft(pi, ctx, state, state.pendingInstructions, existing, signal);
    } else {
      const response = await ctx.ui.editor('Repair saved section response JSON', state.failedResponse);
      if (response === undefined) { await pause(pi, state); return; }
      state.failedResponse = response;
      await save(state);
      const id = existing?.id ?? `s${Math.max(0, ...state.sections.map(section => Number(section.id.slice(1)))) + 1}`;
      const parsed = parseDraft(state, id, state.pendingInstructions, response, existing);
      await commitCandidate(pi, ctx, state, parsed.section, parsed.summary, signal);
    }
    hasShownPreview = true;
  } else if (state.phase === 'ERROR') {
    announce(pi, state.error ?? 'A previous operation failed.');
    state.phase = state.currentId ? 'REVIEW' : 'READY';
    await save(state);
  }
  if (state.phase === 'COMPLETE') { announce(pi, `Specification is complete: ${state.tex}\n${state.workspace}/spec.pdf`); return; }
  if (state.currentId && !hasShownPreview) {
    const current = state.sections.find(section => section.id === state.currentId)!;
    preview(pi, state, `${current.heading}, revision ${current.revision}: restored for review`, current.id);
  }
  while (true) {
    if (state.currentId) {
      state.phase = 'REVIEW';
      const result = await reviewSection(pi, ctx, state, signal);
      if (result === 'exit') return;
      if (result === 'finish') { if (await finalize(pi, ctx, state, signal)) return; }
    }
    const unapproved = state.sections.find(section => !section.approved || section.needsReview);
    if (unapproved) { state.currentId = unapproved.id; state.phase = 'REVIEW'; await save(state); preview(pi, state, `${unapproved.heading}: approval required`, unapproved.id); continue; }
    const instructions = await readInstructions(ctx, state, state.sections.length ? 'What should the next section cover?' : 'What should the first section cover? Describe it in as much or as little detail as you like.', state.pendingInstructions);
    if (instructions === undefined) { await pause(pi, state); return; }
    if (/^(?:(?:please\s+)?(?:finish|finalize)(?:\s+(?:the|this))?(?:\s+(?:specification|document|spec))?|(?:the |this )?(?:specification|document|spec) is complete)[.!]?$/i.test(instructions.trim())) {
      if (await ctx.ui.confirm('Finish the specification?', 'Start document-wide review and final visual approval?')) {
        state.pendingInstructions = undefined;
        await save(state);
        if (await finalize(pi, ctx, state, signal)) return;
      }
      continue;
    }
    await draft(pi, ctx, state, instructions, undefined, signal);
  }
}

export function registerCommands(pi: ExtensionAPI) {
  let active: SpecState | undefined;
  let controller: AbortController | undefined;
  pi.on('session_shutdown', () => { controller?.abort(); });
  const handler = async (args: string, ctx: ExtensionCommandContext) => {
    if (controller) { ctx.ui.notify('A document operation is already active.', 'warning'); return; }
    if (!ctx.hasUI) { ctx.ui.notify('This command requires interactive OMP.', 'error'); return; }
    const [action = '', ...rest] = args.trim().split(/\s+/);
    if (action && !Object.hasOwn(actions, action)) { ctx.ui.notify('Unknown action. Use /mdspec help.', 'error'); return; }
    if (action === 'help') { announce(pi, '/mdspec [resume <directory>|status|outline|preview [all|sN]|revise|goto [sN]|finish|configure|reconcile|recover]\nOne section, one Markdown preview mirrored from the LaTeX source, one explicit approval. Ctrl+C cancels an operation; Escape saves and exits a dialog.'); return; }
    controller = new AbortController();
    const signal = controller.signal;
    const unsubscribe = ctx.ui.onTerminalInput(input => { if (input === '\x03') controller?.abort(); return undefined; });
    let release: (() => Promise<void>) | undefined;
    let ownsWorkspace = false;
    try {
      if (!action) { const target = await selectDestination(ctx); if (!target) return; active = target.state; }
      else {
        const workspace = await findWorkspace(ctx, action === 'resume' || action === 'recover' ? rest.join(' ') || active?.workspace : active?.workspace);
        release = await lock(workspace);
        if (action === 'recover') {
          const selected = await ctx.ui.select('Choose an approved checkpoint', await listCheckpoints({ workspace }));
          if (selected && await ctx.ui.confirm('Restore checkpoint?', 'This restores approved source and backs up current source and state first.')) {
            active = await recover(workspace, selected);
            sessionState(pi, active);
          }
          return;
        }
        active = await findActive(ctx, workspace);
      }
      release ??= await lock(active.workspace);
      ownsWorkspace = true;
      if (action === 'status' || action === 'outline') {
        announce(pi, `${active.title}: ${active.phase}\n${active.tex}\n${markdownPath(active)}\n${active.build?.pages ?? 0} verified pages\n${active.sections.map(section => `${section.id}: ${section.heading} [${section.needsReview ? 'impact review' : section.approved ? 'approved' : 'draft'}], revision ${section.revision}, pages ${section.pages.join(', ')}`).join('\n')}`);
        return;
      }
      if (action === 'reconcile') { await reconcile(pi, ctx, active, signal); return; }
      await assertUnchanged(active);
      if (!active.build) {
        transition(active, 'COMPILING');
        await save(active);
        startActivity(ctx, 'Typesetting', active.title, 'Compiling the scaffold and writing its Markdown mirror');
        const result = await compile(active, active.source, active.sections, signal);
        stopActivity(ctx);
        active.build = result.build;
        transition(active, 'READY');
        await publish(active, active.source);
        announce(pi, `Scaffold compiled successfully: ${active.tex}\n${markdownPath(active)}\n${active.build.pages} pages.`);
      }
      sessionState(pi, active);
      if (action === 'configure') { await configure(pi, ctx, active, signal); return; }
      if (action === 'preview') {
        const requested = rest[0];
        const current = active.sections.find(section => section.id === (requested && requested !== 'all' ? requested : active!.currentId));
        if (requested && requested !== 'all' && !current) throw new Error(`Unknown section: ${requested}`);
        if (requested === 'all' || !current) preview(pi, active, active.title);
        else preview(pi, active, `${current.heading}, revision ${current.revision}`, current.id);
        return;
      }
      if (action === 'finish') {
        if (active.phase === 'PAUSED') active.phase = active.currentId ? 'REVIEW' : 'READY';
        if (active.phase === 'COMPLETE') { announce(pi, 'The specification is already complete.'); return; }
        if (await finalize(pi, ctx, active, signal)) return;
      }
      let hasShownPreview = false;
      if (action === 'revise' || action === 'goto') {
        const selected = rest[0] ? active.sections.find(section => section.id === rest[0]) : await chooseSection(ctx, active);
        if (!selected) return;
        active.currentId = selected.id;
        active.phase = 'REVIEW';
        await save(active);
        if (action === 'revise') {
          const instructions = await readInstructions(ctx, active, 'What needs to change?');
          if (instructions !== undefined) { await draft(pi, ctx, active, instructions, selected, signal); hasShownPreview = true; }
        }
      }
      await guide(pi, ctx, active, signal, hasShownPreview);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (active && ownsWorkspace) { active.error = message; if (signal.aborted) { active.pausedFrom = active.currentId ? 'REVIEW' : 'READY'; active.phase = 'PAUSED'; } else active.phase = 'ERROR'; await save(active); sessionState(pi, active); }
      announce(pi, `${message}\nLast verified source and approved checkpoints remain intact. Use /mdspec resume to retry or edit the saved candidate. External edits: /mdspec reconcile.`);
      ctx.ui.notify(message.slice(0, 1500), 'error');
    } finally {
      stopActivity(ctx);
      unsubscribe();
      await release?.();
      controller = undefined;
    }
  };
  for (const name of ['master-document-spec', 'mdspec']) pi.registerCommand(name, { description: 'Author, resume, review and finish a technical specification', handler });
  pi.registerTool({
    name: 'master_document_spec_status', label: 'Specification status',
    description: 'Read the durable outline, approval state, requirements, decisions and glossary. This tool cannot approve or advance authoring.',
    approval: 'read', parameters: pi.typebox.Type.Object({}),
    execute: async (_id, _params, _signal, _update, ctx) => {
      const state = await findActive(ctx, active?.workspace);
      return {
        content: [{ type: 'text', text: JSON.stringify({
          title: state.title, phase: state.phase,
          sections: state.sections.map(section => ({
            id: section.id, heading: section.heading, approved: section.approved, needsReview: section.needsReview,
            requirements: section.requirements, decisions: section.decisions, questions: section.questions,
            glossary: section.glossary, references: section.references,
          })),
        }, null, 2) }],
        details: {},
      };
    },
  });
}
