import { getLanguage, translate, type Message } from "./i18n.ts";
import { translations } from "./locales.ts";

export const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id)! as T;

export const input = (id: string) => element<HTMLInputElement>(id);

const messages = new Map<string, Message>();

export function text(id: string, source: Message): void {
  messages.set(id, source);
  const value = translate(source);
  const target = element(id);
  if (target.textContent !== value) target.textContent = value;
}

/** Bind original markup once, preserving inputs, nested elements and handlers. */
export function bindDocumentTranslations(): () => void {
  const nodes: { node: Text; source: string }[] = [];
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest("script, style, textarea, #language")) continue;
    const source = node.data.replace(/\s+/g, " ").trim();
    if (Object.hasOwn(translations, source)) nodes.push({ node, source });
  }
  const attributes = Array.from(document.querySelectorAll("[aria-label]"), node => ({
    node, source: node.getAttribute("aria-label")!,
  }));
  return () => {
    document.documentElement.lang = getLanguage();
    for (const { node, source } of nodes) {
      if (node.isConnected) node.data = translate(source);
    }
    for (const { node, source } of attributes) node.setAttribute("aria-label", translate(source));
    for (const [id, source] of messages) text(id, source);
  };
}

export function pressed(id: string, value: boolean): void {
  element(id).setAttribute("aria-pressed", String(value));
}
