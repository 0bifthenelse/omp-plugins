import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { Container, Markdown, Spacer, Text, getMarkdownTheme } from '@oh-my-pi/pi-tui';
import { renderDocument } from './markdown';
import { markdownPath } from './state';
import type { SpecState } from './state';

export function registerPreviewRenderer(pi: ExtensionAPI) {
  pi.registerMessageRenderer('master-document-spec-preview', (message, _options, theme) => {
    const container = new Container();
    const details = message.details as { caption?: string } | undefined;
    if (details?.caption) {
      container.addChild(new Text(theme.bold(theme.fg('accent', details.caption)), 0, 0));
      container.addChild(new Spacer(1));
    }
    container.addChild(new Markdown(typeof message.content === 'string' ? message.content : message.content.map(block => block.type === 'text' ? block.text : '').join(''), 1, 0, getMarkdownTheme()));
    return container;
  });
}

export function preview(pi: ExtensionAPI, state: SpecState, caption: string, sectionId?: string) {
  const document = renderDocument(state, state.sections);
  const markdown = sectionId === undefined ? document.markdown : document.sections[sectionId];
  if (markdown === undefined) throw new Error(`Unknown section: ${sectionId}`);
  pi.sendMessage({ customType: 'master-document-spec-preview', display: true, content: markdown, details: { caption: `${caption}\n${markdownPath(state)}`, section: sectionId, build: state.build?.pdfHash } });
}
