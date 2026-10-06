import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@oh-my-pi/pi-tui';
import type { Theme, ThemeColor } from '@oh-my-pi/pi-tui';
import { renderLatex } from './markdown';

type Activity = { verb: string; target: string; detail: string; response: string; thinking: string; startedAt: number };
type Excerpt = { length: number; lines: string[]; words: number; heading?: string };

const widgetKey = 'master-document-spec-activity';
const orbit = ['◜', '◠', '◝', '◞', '◡', '◟'];
const levels = '▁▂▃▄▅▆▇█';
let activity: Activity | undefined;
let excerpt: Excerpt = { length: -1, lines: [], words: 0 };

export function startActivity(ctx: ExtensionContext, verb: string, target: string, detail = '') {
  activity = { verb, target, detail, response: '', thinking: '', startedAt: Date.now() };
  excerpt = { length: -1, lines: [], words: 0 };
  ctx.ui.setWidget(widgetKey, (tui, theme) => {
    const timer = setInterval(() => tui.requestRender(), 80);
    return { render: (width: number) => renderActivity(theme, width), invalidate() {}, dispose() { clearInterval(timer); } };
  });
}
export function updateActivity(patch: Partial<Omit<Activity, 'startedAt'>>) { if (activity) Object.assign(activity, patch); }
export function stopActivity(ctx: ExtensionContext) {
  activity = undefined;
  ctx.ui.setWidget(widgetKey, undefined);
}

function readJsonString(text: string, key: string) {
  const raw = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`))?.[1];
  if (raw === undefined) return;
  try { return JSON.parse(`"${raw.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, '')}"`) as string; } catch { return; }
}
function wrap(text: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && visibleWidth(line) + 1 + visibleWidth(word) > width) { lines.push(line); line = ''; }
      line = line ? `${line} ${word}` : word;
    }
    if (line || lines.at(-1)) lines.push(line);
  }
  while (lines.at(-1) === '') lines.pop();
  return lines;
}
function readExcerpt(response: string, width: number) {
  if (excerpt.length === response.length + width) return excerpt;
  const latex = readJsonString(response, 'latex');
  let markdown = '';
  try { markdown = latex === undefined ? '' : renderLatex(latex); } catch { markdown = latex ?? ''; }
  excerpt = { length: response.length + width, lines: wrap(markdown, width).slice(-8), words: markdown.split(/\s+/).filter(Boolean).length, heading: readJsonString(response, 'heading') };
  return excerpt;
}
function renderWave(theme: Theme, width: number, time: number) {
  const head = (time * 24) % (width + 16) - 8;
  let wave = '';
  for (let column = 0; column < width; column++) {
    const height = (Math.sin(column * 0.31 + time * 5.2) + Math.sin(column * 0.11 - time * 2.7) + 2) / 4;
    const distance = Math.abs(column - head);
    const glow = Math.max(0, 1 - distance / 6);
    const level = Math.min(levels.length - 1, Math.floor((height * 0.7 + glow * 0.5) * levels.length));
    const color: ThemeColor = glow > 0.6 ? 'accent' : glow > 0.2 ? 'borderAccent' : height > 0.55 ? 'muted' : 'dim';
    wave += theme.fg(color, levels[level]);
  }
  return wave;
}
function renderActivity(theme: Theme, width: number): string[] {
  if (!activity) return [];
  const time = (Date.now() - activity.startedAt) / 1000;
  const inner = Math.max(10, width - 4);
  const seconds = Math.floor(time);
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const signal = (Math.floor(time * 12) * 2654435761 >>> 0).toString(16).slice(-4).toUpperCase();
  const title = `${theme.fg('accent', orbit[Math.floor(time * 10) % orbit.length])} ${theme.bold(theme.fg('accent', activity.verb.toUpperCase()))} ${theme.fg('text', activity.target)}`;
  const status = theme.fg('dim', `0x${signal} ${clock}`);
  const gap = Math.max(1, width - 2 - visibleWidth(title) - visibleWidth(status));
  const lines = [` ${title}${' '.repeat(gap)}${status}`, `  ${renderWave(theme, inner, time)}`];
  if (activity.detail) lines.push(`  ${theme.fg('borderAccent', '⟫')} ${theme.fg('muted', activity.detail)}`);
  const current = readExcerpt(activity.response, inner - 4);
  if (current.heading) lines.push(`  ${theme.fg('borderAccent', '⟫')} ${theme.fg('muted', 'Writing')} ${theme.bold(theme.fg('text', current.heading))}`);
  const cursor = Math.floor(time * 2) % 2 ? theme.fg('accent', '▌') : ' ';
  if (current.lines.length) {
    for (const [index, line] of current.lines.entries()) lines.push(`  ${theme.fg('borderAccent', '│')} ${/^#{1,6} /.test(line) ? theme.bold(theme.fg('accent', line)) : theme.fg('text', line)}${index === current.lines.length - 1 ? cursor : ''}`);
    lines.push(`  ${theme.fg('dim', `${current.words} words streamed`)}`);
  } else if (activity.thinking) {
    for (const line of wrap(activity.thinking.slice(-600), inner - 4).slice(-2)) lines.push(`  ${theme.fg('borderMuted', '┊')} ${theme.fg('dim', line)}`);
  }
  return lines.map(line => truncateToWidth(line, width));
}
