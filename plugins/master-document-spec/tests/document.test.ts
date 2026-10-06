import { test, expect } from 'bun:test';
import { escapeText, replaceSection, sectionSource, pageRanges } from '../src/document';
import { validateLatex, reviewIssues } from '../src/validation';
import { createSection, createState } from './fixture';
import { rm } from 'node:fs/promises';
import { renderDocument } from '../src/markdown';

test('section replacement leaves earlier and later text untouched', () => {
  const first = createSection('s1');
  const second = { ...createSection('s2'), latex: 'Existing approved later content.' };
  const source = `\\begin{document}\n${sectionSource(first)}${sectionSource(second)}\\end{document}\n`;
  const revised = { ...first, heading: 'Revised heading', latex: 'Revised text.' };
  const result = replaceSection(source, revised);
  expect(result).toContain(sectionSource(second));
  expect(result).toContain('\\label{sec:s1}');
  expect(result).not.toContain(first.latex);
  expect(result).toContain(revised.latex);
  expect(() => replaceSection(source.replace('\\specend{s1}', ''), revised)).toThrow();
});
test('physical page mapping supports shared pages and long sections', () => {
  const aux = '\\zref@newlabel{start-s1}{\\default{}\\abspage{3}}\n\\zref@newlabel{end-s1}{\\abspage{6}}\n\\zref@newlabel{start-s2}{\\abspage{6}}\n\\zref@newlabel{end-s2}{\\abspage{7}}';
  expect(pageRanges(aux, [createSection('s1'), createSection('s2')], 7)).toEqual([{ id: 's1', pages: [3, 4, 5, 6] }, { id: 's2', pages: [6, 7] }]);
  expect(() => pageRanges(aux, [createSection('s1')], 4)).toThrow();
});
test('ordinary Unicode text escapes safely and executable TeX is rejected', () => {
  expect(escapeText('État A&B_1 50%')).toBe('État A\\&B\\_1 50\\%');
  validateLatex('\\begin{lstlisting}\nconst path = "\\input{secret}";\n\\end{lstlisting}');
  for (const latex of ['\\input{/etc/passwd}', '\\write18{touch /tmp/x}', '\\csname input\\endcsname', '^^5cinput{secret}', '\\includegraphics{../private.pdf}', '\\begin{document}secret\\end{document}']) expect(() => validateLatex(latex)).toThrow();
  expect(() => validateLatex('\\begin{itemize}\\end{enumerate}')).toThrow('unbalanced');
});
test('final review reports unapproved content unresolved traceability and glossary conflict', async () => {
  const state = await createState();
  try {
    const first = { ...createSection(), latex: 'See \\ref{missing}.', requirements: [{ id: 'REQ-s1-001', text: 'Approval required', acceptance: [], references: ['REQ-s9-001'] }], glossary: { API: 'Application interface' } };
    const second = { ...createSection('s2'), approved: true, needsReview: true, glossary: { API: 'Different meaning' } };
    state.sections = [first, second];
    state.source = replaceSection(replaceSection(state.source, first), second);
    const issues = reviewIssues(state).join('\n');
    expect(issues).toContain('unapproved');
    expect(issues).toContain('acceptance coverage');
    expect(issues).toContain('unresolved traceability');
    expect(issues).toContain('broken reference');
    expect(issues).toContain('impact');
    expect(issues).toContain('glossary');
  } finally { await rm(state.workspace, { recursive: true }); }
});
test('markdown mirror reproduces LaTeX numbering, references, boxes and tables', () => {
  const first = { ...createSection('s1'), heading: 'Scope & goals', latex: 'See Section~\\ref{sec:s2} and \\autoref{req:a}.\n\\subsection{Users}\n\\begin{requirement}{Login}\\label{req:a}\nUsers \\emph{must} log in.\\end{requirement}\n\\begin{table}[h]\\caption{Matrix}\\label{tab:m}\\begin{tabular}{ll}\\toprule A & B \\\\ \\midrule x|y & 50\\% \\\\ \\bottomrule\\end{tabular}\\end{table}\nTable~\\ref{tab:m}, \\ref{missing}.' };
  const appendix = { ...createSection('s2'), heading: 'Glossary', isAppendix: true, latex: '\\begin{acceptance}{T}Pass.\\end{acceptance}' };
  const document = renderDocument({ title: 'Spec', author: '', version: '1.0', date: '2026-10-02', language: 'french' }, [first, appendix]);
  expect(document.sections.s1).toContain('## 1 Scope & goals\n\nSee Section\u00a0A and Requirement 1.1.');
  expect(document.sections.s1).toContain('### 1.1 Users');
  expect(document.sections.s1).toContain('> **Requirement 1.1: Login**\n>\n> Users *must* log in.');
  expect(document.sections.s1).toContain('*Table 1: Matrix*\n\n| A | B |\n| --- | --- |\n| x\\|y | 50% |');
  expect(document.sections.s1).toContain('Table\u00a01, **??**.');
  expect(document.sections.s2).toContain('> **Acceptance test A.1: T**');
  expect(document.markdown).toContain('## Table des matières\n\n- 1 Scope & goals\n  - 1.1 Users\n- A Glossary');
});
