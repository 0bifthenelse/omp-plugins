import { readFile } from 'node:fs/promises';
import type { Section, SpecState } from './state';

export function escapeText(text: string) {
  const replacements: Record<string, string> = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#', '_': '\\_', '%': '\\%', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' };
  return text.replace(/[\\{}$&#_%~^]/g, character => replacements[character]);
}
export function sectionSource(section: Section) {
  return `\\specstart{${section.id}}\n${section.isAppendix ? '\\specappendix' : '\\section'}{${escapeText(section.heading)}}\\label{sec:${section.id}}\n${section.latex}\n\\par\\FloatBarrier\\specend{${section.id}}\n`;
}
export function replaceSection(source: string, section: Section) {
  const start = `\\specstart{${section.id}}`;
  const end = `\\specend{${section.id}}`;
  const first = source.indexOf(start);
  if (first < 0) {
    const closing = source.lastIndexOf('\\end{document}');
    if (closing < 0) throw new Error('Document closing boundary is missing.');
    return source.slice(0, closing) + sectionSource(section) + source.slice(closing);
  }
  const last = source.indexOf(end, first);
  if (last < 0 || source.indexOf(start, first + start.length) >= 0) throw new Error('Section boundaries are damaged or duplicated.');
  let after = last + end.length;
  if (source[after] === '\n') after++;
  return source.slice(0, first) + sectionSource(section) + source.slice(after);
}
export async function scaffold(state: SpecState) {
  const template = await readFile(new URL('../templates/technical-spec.tex', import.meta.url), 'utf8');
  const substitutions: Record<string, string> = { PAPER: state.paper, LANGUAGE: state.language, TITLE: escapeText(state.title), AUTHOR: escapeText(state.author), VERSION: escapeText(state.version), DATE: escapeText(state.date), SPACING: state.format === 'compact' ? '4pt' : '7pt', SECTIONS: '' };
  return template.replace(/@@([A-Z]+)@@/g, (_match, key: string) => substitutions[key]);
}
export function pageRanges(aux: string, sections: Section[], total: number) {
  return sections.map(section => {
    const readPage = (kind: string) => {
      const match = aux.match(new RegExp(`\\\\zref@newlabel\\{${kind}-${section.id}\\}\\{[^\n]*?\\\\abspage\\{(\\d+)\\}`));
      if (!match) throw new Error(`Cannot determine PDF pages for ${section.id}.`);
      return Number(match[1]);
    };
    const first = readPage('start');
    const last = readPage('end');
    if (first < 1 || last < first || last > total) throw new Error(`Invalid PDF page range for ${section.id}.`);
    return { id: section.id, pages: Array.from({ length: last - first + 1 }, (_, offset) => first + offset) };
  });
}
