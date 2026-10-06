import type { Section, SpecState } from './state';

type Anchor = { number: string; kind: string; title: string; page?: number };
type Context = {
  prefix: string; section: number; appendix: number; subsection: number; subsubsection: number;
  boxes: Record<string, number>; table: number; figure: number; equation: number; footnote: number; citation: number;
  float?: 'table' | 'figure'; page?: number; anchor: Anchor; labels: Map<string, Anchor>;
  footnotes: string[]; contents: string[]; blocks: string[]; isPlain: boolean; references: string;
};
type MarkdownDocument = { markdown: string; sections: Record<string, string> };

const boxTitles: Record<string, [string, boolean]> = {
  requirement: ['Requirement', true], nonfunctional: ['Quality requirement', true], acceptance: ['Acceptance test', true],
  constraint: ['Constraint', false], decision: ['Decision', false], risk: ['Risk', false], example: ['Example', false],
};
const accentMarks: Record<string, string> = { "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307', c: '\u0327', v: '\u030C', H: '\u030B', u: '\u0306', r: '\u030A', b: '\u0331', d: '\u0323', t: '\u0361' };
const letters: Record<string, string> = { ss: 'ß', ae: 'æ', oe: 'œ', AE: 'Æ', OE: 'Œ', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ', ldots: '…', dots: '…', textbackslash: '\\\\', textasciitilde: '~', textasciicircum: '^' };
const symbols: Record<string, string> = { '&': '&', '%': '%', '$': '\\$', '#': '\\#', '_': '\\_', '{': '{', '}': '}', ' ': ' ', ',': '\u2009', ';': ' ', ':': ' ', '!': '', '-': '', '/': '' };
const spacing: Record<string, string> = { quad: '\u2003', qquad: '\u2003\u2003', noindent: '', centering: '', raggedright: '', raggedleft: '', arraybackslash: '', small: '', normalsize: '', large: '', Large: '', scriptsize: '', tiny: '', hline: '', toprule: '', midrule: '', bottomrule: '', FloatBarrier: '' };
const wrappers: Record<string, [string, string]> = { textbf: ['**', '**'], textit: ['*', '*'], emph: ['*', '*'], underline: ['<u>', '</u>'], textsf: ['', ''], textrm: ['', ''], fbox: ['', ''], mathrm: ['', ''] };
const mathEnvironments: Record<string, true | undefined> = Object.fromEntries(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'displaymath', 'math', 'aligned', 'matrix', 'pmatrix', 'bmatrix', 'cases'].map(name => [name, true]));
const tableEnvironments: Record<string, true | undefined> = { tabular: true, tabularx: true, longtable: true };

function createContext(references = 'References'): Context {
  return { prefix: '', section: 0, appendix: 0, subsection: 0, subsubsection: 0, boxes: {}, table: 0, figure: 0, equation: 0, footnote: 0, citation: 0, anchor: { number: '', kind: '', title: '' }, labels: new Map(), footnotes: [], contents: [], blocks: [], isPlain: false, references };
}
function escapeMarkdown(text: string) { return text.replace(/[\\`*_[\]<>#|]/g, character => `\\${character}`); }
function block(context: Context, markdown: string) { context.blocks.push(markdown); return `\n\n\u0002${context.blocks.length - 1}\u0002\n\n`; }
function restore(context: Context, markdown: string): string {
  const restored = markdown.replace(/\u0002(\d+)\u0002/g, (_match, index: string) => context.blocks[Number(index)]);
  return restored === markdown ? restored : restore(context, restored);
}
function tidy(markdown: string) {
  return markdown.replace(/[ \t\r]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ ?\u0003 ?/g, '\\\n').trim();
}
function finish(context: Context, source: string) { return restore(context, tidy(render(source, context))); }
function inline(context: Context, source: string) { return finish(context, source).replace(/\n+/g, ' '); }
function prefixLines(markdown: string, first: string, rest: string) { return markdown.split('\n').map((line, index) => (index ? rest : first) + line).map(line => line.trimEnd()).join('\n'); }

function readGroup(source: string, start: number) {
  let index = start;
  while (source[index] === ' ' || source[index] === '\t' || source[index] === '\n') index++;
  if (source[index] !== '{') {
    const text = source.slice(index).match(/^(?:\\(?:[A-Za-z@]+|.)|.)/s)?.[0] ?? '';
    return { text, end: index + text.length };
  }
  let depth = 0;
  for (let cursor = index; cursor < source.length; cursor++) {
    if (source[cursor] === '\\') { cursor++; continue; }
    if (source[cursor] === '{') depth++;
    if (source[cursor] === '}' && --depth === 0) return { text: source.slice(index + 1, cursor), end: cursor + 1 };
  }
  return { text: source.slice(index + 1), end: source.length };
}
function readOptional(source: string, start: number) {
  let index = start;
  while (source[index] === ' ' || source[index] === '\t') index++;
  if (source[index] !== '[') return { text: undefined, end: start };
  let depth = 0;
  for (let cursor = index; cursor < source.length; cursor++) {
    if (source[cursor] === '\\') { cursor++; continue; }
    if (source[cursor] === '{') depth++;
    if (source[cursor] === '}') depth--;
    if (source[cursor] === ']' && depth === 0) return { text: source.slice(index + 1, cursor), end: cursor + 1 };
  }
  return { text: source.slice(index + 1), end: source.length };
}
function findEnd(source: string, start: number, name: string) {
  const pattern = /\\(begin|end)\{([^}]+)\}/g;
  pattern.lastIndex = start;
  let depth = 1;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (match[2] !== name) continue;
    depth += match[1] === 'begin' ? 1 : -1;
    if (!depth) return { body: source.slice(start, match.index), end: match.index + match[0].length };
  }
  return { body: source.slice(start), end: source.length };
}
function splitTop(source: string, separator: 'item' | 'bibitem' | 'row' | 'cell') {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === '%') { const newline = source.indexOf('\n', index); index = newline < 0 ? source.length : newline; continue; }
    if (character === '{') depth++;
    else if (character === '}') depth--;
    else if (character === '&' && separator === 'cell' && depth === 0) { parts.push(source.slice(last, index)); last = index + 1; }
    else if (character === '\\') {
      const word = source.slice(index + 1).match(/^[A-Za-z@]+/)?.[0];
      if (!word) {
        if (source[index + 1] === '\\' && separator === 'row' && depth === 0) { parts.push(source.slice(last, index)); last = readOptional(source, index + 2).end; }
        index++;
        continue;
      }
      if (word === 'begin') depth++;
      if (word === 'end') depth--;
      if (word === separator && depth === 0) { parts.push(source.slice(last, index)); last = index; }
      index += word.length;
    }
  }
  parts.push(source.slice(last));
  return parts;
}

function setAnchor(context: Context, number: string, kind: string, title = '') { context.anchor = { number, kind, title, page: context.page }; }
function heading(context: Context, level: 'section' | 'subsection' | 'subsubsection', title: string, isNumbered: boolean) {
  const text = inline(context, title);
  if (level === 'section') { context.section++; context.prefix = String(context.section); context.subsection = 0; context.subsubsection = 0; context.boxes = {}; }
  if (level === 'subsection') { context.subsection++; context.subsubsection = 0; }
  if (level === 'subsubsection') context.subsubsection++;
  const number = [context.prefix, ...(level === 'section' ? [] : [context.subsection]), ...(level === 'subsubsection' ? [context.subsubsection] : [])].filter(part => part !== '').join('.');
  const marks = { section: '##', subsection: '###', subsubsection: '####' }[level];
  if (!isNumbered) return `\n\n${marks} ${text}\n\n`;
  setAnchor(context, number, { section: 'Section', subsection: 'Subsection', subsubsection: 'Subsubsection' }[level], text);
  context.contents.push(`${{ section: '', subsection: '  ', subsubsection: '    ' }[level]}- ${number} ${text}`);
  return `\n\n${marks} ${number} ${text}\n\n`;
}
function renderList(context: Context, name: string, body: string) {
  const items = splitTop(body, 'item').slice(1).map(item => {
    const label = readOptional(item, 5);
    return { label: label.text, text: item.slice(label.end) };
  });
  const lines = items.map((item, index) => {
    const marker = name === 'enumerate' ? `${index + 1}. ` : '- ';
    const label = item.label === undefined ? '' : name === 'description' ? `**${inline(context, item.label)}** ` : `${inline(context, item.label)} `;
    return prefixLines(label + finish(context, item.text), marker, ' '.repeat(marker.length));
  });
  return block(context, lines.join('\n'));
}
function renderTable(context: Context, name: string, source: string) {
  let cursor = name === 'longtable' ? readOptional(source, 0).end : 0;
  if (name === 'tabular') cursor = readOptional(source, cursor).end;
  if (name === 'tabularx') cursor = readGroup(source, cursor).end;
  const body = source.slice(readGroup(source, cursor).end);
  const rows: string[][] = [];
  const before: string[] = [];
  const after: string[] = [];
  for (const row of splitTop(body, 'row')) {
    if (!row.replace(/\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\})/g, '').trim()) continue;
    const cells = splitTop(row, 'cell').flatMap(cell => {
      const rendered = inline(context, cell).replace(/(?<!\\)\|/g, '\\|');
      const spans = rendered.split('\u0004');
      return [spans.join(''), ...Array(spans.length - 1).fill('')];
    });
    if (cells.length === 1 && /^\*(?:Table|Figure) /.test(cells[0])) { (rows.length ? after : before).push(cells[0]); continue; }
    rows.push(cells);
  }
  const width = Math.max(1, ...rows.map(row => row.length));
  const lines = rows.map(row => `| ${[...row, ...Array(width - row.length).fill('')].join(' | ')} |`);
  if (lines.length) lines.splice(1, 0, `|${' --- |'.repeat(width)}`);
  return [...before, block(context, lines.join('\n')), ...after].join('\n\n');
}
function renderMath(context: Context, name: string, body: string) {
  if (name === 'math') return `$${body.trim()}$`;
  const isNumbered = ['equation', 'align', 'gather'].includes(name);
  const rows = name === 'align' || name === 'gather' ? body.split(/\\\\/) : [body];
  const numbered = rows.map(row => {
    const labels = [...row.matchAll(/\\label\{([^}]+)\}/g)].map(match => match[1]);
    let text = row.replace(/\\label\{[^}]+\}/g, '');
    if (isNumbered && !/\\no(?:number|tag)\b/.test(text) && text.trim()) {
      context.equation++;
      setAnchor(context, String(context.equation), 'Equation');
      text = `${text.trimEnd()} \\qquad (${context.equation})`;
    }
    for (const label of labels) context.labels.set(label, context.anchor);
    return text.replace(/\\no(?:number|tag)\b/g, '').trim();
  });
  const inner = name.startsWith('align') ? `\\begin{aligned}\n${numbered.join(' \\\\\n')}\n\\end{aligned}` : name.startsWith('gather') ? `\\begin{gathered}\n${numbered.join(' \\\\\n')}\n\\end{gathered}` : ['equation', 'equation*', 'displaymath'].includes(name) ? numbered.join('') : `\\begin{${name}}${body}\\end{${name}}`;
  return block(context, `$$\n${inner.trim()}\n$$`);
}
function renderEnvironment(context: Context, name: string, source: string) {
  if (name === 'itemize' || name === 'enumerate' || name === 'description') return renderList(context, name, source);
  if (Object.hasOwn(tableEnvironments, name)) return renderTable(context, name, source);
  if (Object.hasOwn(mathEnvironments, name)) return renderMath(context, name, source);
  if (name === 'verbatim' || name === 'lstlisting') {
    const options = name === 'lstlisting' ? readOptional(source, 0) : { text: undefined, end: 0 };
    const language = options.text?.match(/language=\{?([A-Za-z0-9+#-]+)/)?.[1]?.toLowerCase() ?? '';
    const code = source.slice(options.end).replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
    const fence = '`'.repeat(Math.max(3, ...[...code.matchAll(/`+/g)].map(match => match[0].length + 1)));
    return block(context, `${fence}${language}\n${code}\n${fence}`);
  }
  if (name === 'tikzpicture') return block(context, `\`\`\`latex\n\\begin{tikzpicture}${source}\\end{tikzpicture}\n\`\`\``);
  if (Object.hasOwn(boxTitles, name)) {
    const [label, isNumbered] = boxTitles[name];
    const argument = readGroup(source, 0);
    const title = inline(context, argument.text);
    let caption = `${label} ${title}`;
    if (isNumbered) {
      context.boxes[name] = (context.boxes[name] ?? 0) + 1;
      const number = [context.prefix, context.boxes[name]].filter(part => part !== '').join('.');
      setAnchor(context, number, label, title);
      caption = `${label} ${number}: ${title}`;
    }
    const body = finish(context, source.slice(argument.end));
    return block(context, prefixLines(`**${caption.trim()}**${body ? `\n\n${body}` : ''}`, '> ', '> '));
  }
  if (name === 'quote' || name === 'quotation') return block(context, prefixLines(finish(context, source), '> ', '> '));
  if (name === 'table' || name === 'figure' || name === 'table*' || name === 'figure*') {
    const previous = context.float;
    context.float = name.startsWith('table') ? 'table' : 'figure';
    const body = render(source.slice(readOptional(source, 0).end), context);
    context.float = previous;
    return `\n\n${body}\n\n`;
  }
  if (name === 'thebibliography') {
    const items = splitTop(source.slice(readGroup(source, 0).end), 'bibitem').slice(1).map(item => {
      const key = readGroup(item, 8);
      context.citation++;
      context.labels.set(`cite:${key.text}`, { number: String(context.citation), kind: 'Citation', title: '' });
      return `[${context.citation}] ${inline(context, item.slice(key.end))}`;
    });
    return `\n\n## ${context.references}\n\n${block(context, items.join('\\\n'))}`;
  }
  return `\n\n${render(source, context)}\n\n`;
}

function renderCommand(context: Context, source: string, start: number): { markdown: string; end: number } {
  const token = source.slice(start).match(/^\\(?:([A-Za-z@]+)(\*?)|(.))/s);
  if (!token) return { markdown: '', end: source.length };
  let end = start + token[0].length;
  const symbol = token[3];
  if (symbol !== undefined) {
    if (symbol === '\\') return { markdown: '\u0003', end: readOptional(source, end).end };
    if (Object.hasOwn(accentMarks, symbol)) { const argument = readGroup(source, end); return { markdown: (render(argument.text, context) + accentMarks[symbol]).normalize('NFC'), end: argument.end }; }
    if (symbol === '(' || symbol === '[') {
      const closing = source.indexOf(symbol === '(' ? '\\)' : '\\]', end);
      const math = source.slice(end, closing < 0 ? undefined : closing).trim();
      return { markdown: symbol === '(' ? `$${math}$` : block(context, `$$\n${math}\n$$`), end: closing < 0 ? source.length : closing + 2 };
    }
    if (context.isPlain && '&%$#_{}'.includes(symbol)) return { markdown: symbol, end };
    return { markdown: symbols[symbol] ?? escapeMarkdown(symbol), end };
  }
  const name = token[1];
  const isStarred = token[2] === '*';
  if (/^[A-Za-z]/.test(name)) while (source[end] === ' ' || source[end] === '\t') end++;
  const argument = () => { const group = readGroup(source, end); end = group.end; return group.text; };
  const optional = () => { const group = readOptional(source, end); end = group.end; return group.text; };
  if (Object.hasOwn(accentMarks, name)) { const text = argument(); return { markdown: (render(text, context) + accentMarks[name]).normalize('NFC'), end }; }
  if (Object.hasOwn(letters, name)) { if (source[end] === '{' && source[end + 1] === '}') end += 2; return { markdown: letters[name], end }; }
  if (Object.hasOwn(spacing, name)) return { markdown: spacing[name], end };
  if (Object.hasOwn(wrappers, name)) { const [open, close] = wrappers[name]; const text = inline(context, argument()); return { markdown: text ? `${open}${text}${close}` : '', end }; }
  switch (name) {
    case 'texttt': {
      const wasPlain = context.isPlain;
      context.isPlain = true;
      const code = inline(context, argument());
      context.isPlain = wasPlain;
      const fence = code.includes('`') ? '``' : '`';
      return { markdown: `${fence}${code}${fence}`, end };
    }
    case 'section': case 'subsection': case 'subsubsection': return { markdown: heading(context, name, argument(), !isStarred), end };
    case 'paragraph': case 'subparagraph': return { markdown: `\n\n**${inline(context, argument())}** `, end };
    case 'label': context.labels.set(argument(), context.anchor); return { markdown: '', end };
    case 'ref': return { markdown: `\u0001ref:${argument()}\u0001`, end };
    case 'eqref': return { markdown: `(\u0001ref:${argument()}\u0001)`, end };
    case 'autoref': return { markdown: `\u0001auto:${argument()}\u0001`, end };
    case 'nameref': return { markdown: `\u0001name:${argument()}\u0001`, end };
    case 'pageref': return { markdown: `\u0001page:${argument()}\u0001`, end };
    case 'hyperref': { const label = optional(); const text = inline(context, argument()); return { markdown: label ? `[${text}](#${label})` : text, end }; }
    case 'href': { const url = argument(); return { markdown: `[${inline(context, argument())}](${url})`, end }; }
    case 'url': return { markdown: `<${argument()}>`, end };
    case 'cite': { optional(); return { markdown: `[${argument().split(',').map(key => `\u0001ref:cite:${key.trim()}\u0001`).join(', ')}]`, end }; }
    case 'footnote': {
      context.footnote++;
      const number = context.footnote;
      context.footnotes.push(`[^${number}]: ${inline(context, argument())}`);
      return { markdown: `[^${number}]`, end };
    }
    case 'caption': {
      optional();
      const text = inline(context, argument());
      const kind = context.float === 'figure' ? 'Figure' : 'Table';
      const number = kind === 'Figure' ? ++context.figure : ++context.table;
      setAnchor(context, String(number), kind, text);
      return { markdown: `\n\n*${kind} ${number}: ${text}*\n\n`, end };
    }
    case 'includegraphics': { optional(); const path = argument(); return { markdown: `![${escapeMarkdown(path.split('/').at(-1) ?? path)}](${path.replace(/ /g, '%20')})`, end }; }
    case 'begin': {
      const environment = argument();
      const found = findEnd(source, end, environment);
      return { markdown: renderEnvironment(context, environment, found.body), end: found.end };
    }
    case 'end': argument(); return { markdown: '', end };
    case 'item': { const label = optional(); return { markdown: `\n- ${label === undefined ? '' : `${inline(context, label)} `}`, end }; }
    case 'par': case 'newpage': case 'clearpage': return { markdown: '\n\n', end };
    case 'newline': case 'linebreak': optional(); return { markdown: '\u0003', end };
    case 'vspace': case 'hspace': argument(); return { markdown: '', end };
    case 'color': argument(); return { markdown: '', end };
    case 'textcolor': argument(); return { markdown: inline(context, argument()), end };
    case 'cline': argument(); return { markdown: '', end };
    case 'rule': optional(); argument(); argument(); return { markdown: '\n\n---\n\n', end };
    case 'multicolumn': { const span = Number(argument()) || 1; argument(); return { markdown: inline(context, argument()) + '\u0004'.repeat(span - 1), end }; }
    case 'multirow': argument(); argument(); return { markdown: inline(context, argument()), end };
    default: return { markdown: '', end };
  }
}

function render(source: string, context: Context): string {
  let markdown = '';
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '%') { const newline = source.indexOf('\n', index); index = newline < 0 ? source.length : newline + 1; continue; }
    if (/\s/.test(character)) {
      let newlines = 0;
      while (index < source.length && /\s/.test(source[index])) { if (source[index] === '\n') newlines++; index++; }
      markdown += newlines >= 2 ? '\n\n' : ' ';
      continue;
    }
    if (character === '$') {
      const isDisplay = source[index + 1] === '$';
      const opening = isDisplay ? 2 : 1;
      const closing = source.indexOf(isDisplay ? '$$' : '$', index + opening);
      const math = source.slice(index + opening, closing < 0 ? undefined : closing).trim();
      markdown += isDisplay ? block(context, `$$\n${math}\n$$`) : `$${math}$`;
      index = closing < 0 ? source.length : closing + opening;
      continue;
    }
    if (character === '{') { const group = readGroup(source, index); markdown += render(group.text, context); index = group.end; continue; }
    if (character === '}') { index++; continue; }
    if (character === '\\') { const command = renderCommand(context, source, index); markdown += command.markdown; index = command.end; continue; }
    if (character === '~') { markdown += '\u00a0'; index++; continue; }
    if (character === '-' && !context.isPlain) {
      const dashes = source.slice(index).match(/^-{1,3}/)![0];
      markdown += dashes.length === 3 ? '—' : dashes.length === 2 ? '–' : '-';
      index += dashes.length;
      continue;
    }
    if (!context.isPlain && (character === '`' || character === "'")) {
      const isDouble = source[index + 1] === character;
      markdown += character === '`' ? (isDouble ? '“' : '‘') : (isDouble ? '”' : '’');
      index += isDouble ? 2 : 1;
      continue;
    }
    markdown += context.isPlain ? character : escapeMarkdown(character);
    index++;
  }
  return markdown;
}

function resolveReferences(markdown: string, labels: Map<string, Anchor>) {
  return markdown.replace(/\u0001(ref|auto|name|page):([^\u0001]*)\u0001/g, (_match, kind: string, label: string) => {
    const anchor = labels.get(label);
    if (!anchor) return '**??**';
    if (kind === 'auto') return `${anchor.kind} ${anchor.number}`.trim();
    if (kind === 'name') return anchor.title;
    if (kind === 'page') return String(anchor.page ?? '??');
    return anchor.number;
  });
}

export function renderLatex(latex: string) {
  const context = createContext();
  return resolveReferences(finish(context, latex), context.labels);
}

export function renderDocument(state: Pick<SpecState, 'title' | 'author' | 'version' | 'date' | 'language'>, sections: readonly Section[]): MarkdownDocument {
  const isFrench = state.language === 'french';
  const context = createContext(isFrench ? 'Références' : 'References');
  const bodies: [string, string][] = [];
  for (const section of sections) {
    context.page = section.pages[0];
    context.footnotes = [];
    if (section.isAppendix) context.prefix = String.fromCharCode(65 + context.appendix++);
    else context.prefix = String(++context.section);
    context.subsection = 0;
    context.subsubsection = 0;
    context.boxes = {};
    const text = escapeMarkdown(section.heading);
    setAnchor(context, context.prefix, section.isAppendix ? 'Appendix' : 'Section', text);
    context.contents.push(`- ${context.prefix} ${text}`);
    context.labels.set(`sec:${section.id}`, context.anchor);
    const body = finish(context, section.latex);
    bodies.push([section.id, [`## ${context.prefix} ${text}`, body, context.footnotes.join('\n')].filter(Boolean).join('\n\n')]);
  }
  const rendered = Object.fromEntries(bodies.map(([id, markdown]) => [id, resolveReferences(markdown, context.labels)]));
  const front = [
    'TECHNICAL SPECIFICATION', `# ${escapeMarkdown(state.title)}`, '---',
    [state.author && escapeMarkdown(state.author), `Version ${escapeMarkdown(state.version)}`, escapeMarkdown(state.date)].filter(Boolean).join('\\\n'),
    `## ${isFrench ? 'Table des matières' : 'Contents'}`, context.contents.join('\n'),
  ].filter(Boolean);
  return { markdown: `${[...front, ...Object.values(rendered)].join('\n\n')}\n`, sections: rendered };
}
