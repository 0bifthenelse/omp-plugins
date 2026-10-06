import type { SpecState } from './state';

const commands: Record<string, true | undefined> = Object.fromEntries(('section subsection subsubsection paragraph subparagraph label ref pageref eqref autoref nameref hyperref href url cite bibitem begin end item textbf textit texttt textsf textrm emph underline footnote caption centering includegraphics rule hline cline toprule midrule bottomrule multicolumn multirow newline linebreak newpage clearpage appendix vspace hspace small normalsize large Large scriptsize tiny raggedright raggedleft arraybackslash color textcolor fbox par noindent quad qquad frac dfrac tfrac sqrt sum prod int iint lim infty sin cos tan log ln exp min max left right le ge leq geq neq approx equiv times cdot pm to rightarrow leftarrow Rightarrow Leftrightarrow mapsto in notin subset subseteq cup cap forall exists neg land lor alpha beta gamma delta epsilon theta lambda mu pi rho sigma tau phi omega Gamma Delta Theta Lambda Pi Sigma Phi Omega mathbb mathcal mathrm mathbf mathit operatorname overline hat vec dot dots ldots cdots text underbrace overbrace overset underset binom matrix pmatrix bmatrix cases aligned align equation displaymath tikz node draw path coordinate fill filldraw foreach percent textbackslash textasciitilde textasciicircum').split(' ').map(command => [command, true]));
const environments: Record<string, true | undefined> = Object.fromEntries(('itemize enumerate description requirement nonfunctional constraint decision risk example acceptance tabular tabularx longtable table table* figure figure* center flushleft flushright quote quotation verbatim lstlisting tikzpicture math displaymath equation equation* align align* aligned gather gather* matrix pmatrix bmatrix cases thebibliography').split(' ').map(environment => [environment, true]));
const accents: Record<string, true | undefined> = { "'": true, '"': true, '`': true, '=': true, c: true, v: true, H: true, u: true, r: true, b: true, d: true, t: true, ss: true, ae: true, oe: true, AE: true, OE: true, o: true, O: true, l: true, L: true, i: true, j: true };
const lengths: Record<string, true | undefined> = { textwidth: true, linewidth: true, columnwidth: true };
const mathCommands: Record<string, true | undefined> = Object.fromEntries(('langle rangle lceil rceil lfloor rfloor vert Vert lvert rvert lVert rVert backslash setminus emptyset varnothing top bot perp parallel partial nabla prime bullet diamond circ oplus otimes iff implies doteq leqslant geqslant varepsilon varphi vartheta varrho varpi varsigma not sim simeq propto ell Re Im det dim ker gcd mod bmod pmod limits nolimits substack tag nonumber notag displaystyle textstyle scriptstyle scriptscriptstyle xrightarrow xleftarrow hphantom vphantom phantom').split(' ').map(command => [command, true]));
export function validateLatex(latex: string) {
  if (/\^\^|\u0000/.test(latex)) throw new Error('Encoded TeX control sequences are not allowed.');
  const executable = latex.replace(/\\begin\{(lstlisting|verbatim)\}(?:\[[^\]]*\])?[\s\S]*?\\end\{\1\}/g, '');
  for (const match of executable.matchAll(/\\([A-Za-z@]+|.)/g)) {
    const command = match[1];
    if (command === 'appendix' || !Object.hasOwn(commands, command) && !Object.hasOwn(accents, command) && !Object.hasOwn(mathCommands, command) && !Object.hasOwn(lengths, command) && !['\\', '{', '}', '%', '_', '#', '&', '$', '~', '^', ' ', ',', ';', ':', '!', '[', ']', '(', ')', '|'].includes(command)) throw new Error(`Unsupported or unsafe LaTeX command: \\${command}`);
  }
  const stack: string[] = [];
  for (const match of executable.matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    if (!Object.hasOwn(environments, match[2])) throw new Error(`Unsupported environment: ${match[2]}`);
    if (match[1] === 'begin') stack.push(match[2]);
    else if (stack.pop() !== match[2]) throw new Error('LaTeX environments are unbalanced.');
  }
  if (stack.length) throw new Error('LaTeX environment is not closed.');
  for (const match of executable.matchAll(/\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g)) {
    if (!/^assets\/[A-Za-z0-9_./ -]+\.(png|jpg|jpeg|pdf)$/i.test(match[1]) || match[1].split('/').includes('..')) throw new Error('Figures must reference a local file under assets/.');
  }
  for (const match of executable.matchAll(/\\href\{([^}]+)\}/g)) if (!/^https?:\/\//i.test(match[1])) throw new Error('Links must use HTTP or HTTPS.');
}
export function reviewIssues(state: SpecState) {
  const issues: string[] = [];
  const requirements = state.sections.flatMap(section => section.requirements);
  const known = new Set(requirements.map(requirement => requirement.id));
  const labels = new Set([...state.source.matchAll(/\\label\{([^}]+)\}/g)].map(match => match[1]));
  for (const section of state.sections) {
    if (!section.approved) issues.push(`${section.id}: section is unapproved.`);
    if (section.needsReview) issues.push(`${section.id}: downstream impact needs explicit reapproval.`);
    for (const question of section.questions) issues.push(`${section.id}: unresolved decision: ${question}`);
    if (/TODO|TBD|TO CONFIRM|placeholder|FIXME/i.test(section.latex)) issues.push(`${section.id}: possible placeholder remains.`);
    for (const reference of section.references) if (!reference.verified) issues.push(`${section.id}: unverified reference: ${reference.source}`);
    for (const requirement of section.requirements) {
      if (!requirement.acceptance.length) issues.push(`${requirement.id}: acceptance coverage is missing.`);
      for (const reference of requirement.references) if (!known.has(reference) && !labels.has(reference)) issues.push(`${requirement.id}: unresolved traceability link: ${reference}`);
    }
    for (const match of section.latex.matchAll(/\\(?:ref|pageref|eqref|autoref|nameref)\{([^}]+)\}/g)) if (!labels.has(match[1])) issues.push(`${section.id}: broken reference: ${match[1]}`);
  }
  if (known.size !== requirements.length) issues.push('Duplicate requirement identifiers.');
  const terms = new Map<string, string>();
  for (const section of state.sections) for (const [term, definition] of Object.entries(section.glossary)) {
    const existing = terms.get(term.toLowerCase());
    if (existing && existing !== definition) issues.push(`Inconsistent glossary definition: ${term}`);
    terms.set(term.toLowerCase(), definition);
  }
  return issues;
}
