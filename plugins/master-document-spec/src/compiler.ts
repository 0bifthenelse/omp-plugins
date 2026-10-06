import { spawn } from 'node:child_process';
import { readFile, mkdir, readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, confine, exists, hash, metadata } from './state';
import type { SpecState, Section } from './state';
import { pageRanges } from './document';

export async function run(command: string, args: string[], cwd: string, signal?: AbortSignal, timeout = 120000) {
  if (signal?.aborted) throw new Error('Operation cancelled.');
  return new Promise<string>((resolve, reject) => {
    let output = '';
    let failure: Error | undefined;
    const child = spawn(command, args, { cwd, shell: false, detached: true, env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => { failure = new Error(signal?.aborted ? 'Operation cancelled.' : `${command} exceeded its timeout.`); try { process.kill(-child.pid!, 'SIGTERM'); } catch {} killTimer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 1500); };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(stop, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    const collect = (chunk: Buffer) => { output += chunk.toString(); if (output.length > 400000) output = output.slice(-400000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', error => { failure = error; });
    child.on('close', code => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); if (failure) reject(failure); else if (code !== 0) reject(new Error(`${command} exited with ${code}.\n${output.slice(-12000)}`)); else resolve(output); });
  });
}
async function inspectAssets(path: string) {
  if (!await exists(path)) return;
  for (const name of await readdir(path)) {
    const entry = join(path, name);
    const stat = await lstat(entry);
    if (stat.isSymbolicLink()) throw new Error('Asset symbolic links are not allowed.');
    if (stat.isDirectory()) await inspectAssets(entry);
  }
}
export async function compile(state: SpecState, source: string, sections: Section[], signal?: AbortSignal) {
  const directory = metadata(state, 'builds', randomUUID());
  await confine(state.workspace, directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomic(state.workspace, join(directory, 'spec.tex'), source);
  await confine(state.workspace, join(state.workspace, 'assets'));
  await inspectAssets(join(state.workspace, 'assets'));
  const sandbox = ['--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/etc', '--dir', '/var', '--dir', '/var/cache'];
  for (const path of ['/etc/fonts', '/etc/texmf', '/etc/ld.so.cache', '/etc/paperspecs', '/etc/papersize', '/var/cache/fontconfig']) if (await exists(path)) sandbox.push('--ro-bind', path, path);
  sandbox.push('--ro-bind', '/bin', '/bin');
  sandbox.push('--bind', directory, '/build', '--chdir', '/build', '--setenv', 'HOME', '/tmp', '--setenv', 'openin_any', 'p', '--setenv', 'openout_any', 'p', '--setenv', 'TEXMFVAR', '/tmp/texmf-var');
  if (await exists(join(state.workspace, 'assets'))) sandbox.push('--ro-bind', join(state.workspace, 'assets'), '/build/assets');
  const paper = state.paper === 'a4paper' ? '210mm,297mm' : '8.5in,11in';
  sandbox.push('/usr/bin/latexmk', '-norc', '-xelatex', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-e', "$xelatex='xelatex -no-shell-escape %O %S'", '-e', `$xdvipdfmx='xdvipdfmx -p ${paper} -E %O -o %D %S'`, 'spec.tex');
  try {
    const output = await run('bwrap', sandbox, directory, signal);
    await atomic(state.workspace, join(directory, 'compiler-output.log'), output);
    const pdf = await readFile(join(directory, 'spec.pdf'));
    if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || !pdf.subarray(-2048).includes(Buffer.from('%%EOF'))) throw new Error('Compiler output is not a complete PDF.');
    const info = await run('pdfinfo', [join(directory, 'spec.pdf')], directory, signal, 15000);
    const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!Number.isSafeInteger(pages) || pages < 1) throw new Error('PDF has no valid page count.');
    await run('mutool', ['info', join(directory, 'spec.pdf')], directory, signal, 15000);
    const log = await readFile(join(directory, 'spec.log'), 'utf8');
    const warnings = log.split('\n').filter(line => /Warning:|Overfull|Underfull|Missing character/.test(line));
    if (/undefined references|Reference .* undefined|Citation .* undefined/.test(log)) throw new Error(`Unresolved LaTeX references.\n${warnings.join('\n')}`);
    const ranges = pageRanges(await readFile(join(directory, 'spec.aux'), 'utf8'), sections, pages);
    for (const name of ['spec.tex', 'spec.xdv', 'spec.aux', 'spec.toc', 'spec.out', 'spec.fls', 'spec.fdb_latexmk']) await rm(join(directory, name), { force: true });
    return { build: { directory, pdfHash: hash(pdf), pages, warnings }, ranges };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await atomic(state.workspace, join(directory, 'failure.log'), message);
    const guidance = process.platform === 'linux' ? 'Gentoo: emerge dev-tex/latexmk app-text/texlive dev-texlive/texlive-xetex dev-texlive/texlive-latexextra dev-texlive/texlive-langfrench app-text/mupdf sys-apps/bubblewrap sys-apps/util-linux. Debian: apt install latexmk texlive-xetex texlive-latex-extra texlive-lang-french mupdf-tools bubblewrap util-linux.' : 'Use a Linux environment with TeX Live, latexmk, MuPDF, bubblewrap and util-linux for confined compilation.';
    throw new Error(`${message}\nBuild logs: ${directory}\n${guidance}`);
  }
}
