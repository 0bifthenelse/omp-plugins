import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { registerCommands } from './src/commands';
import { registerPreviewRenderer } from './src/preview';

export default function masterDocumentSpec(pi: ExtensionAPI) {
  registerPreviewRenderer(pi);
  registerCommands(pi);
}
