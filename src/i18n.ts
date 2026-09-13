import { translations } from "./locales.ts";

export const languages = ["en", "ja", "ko", "zh-CN"] as const;
export type Language = typeof languages[number];
export const LANGUAGE_STORAGE_KEY = "planetarium.language";
export type Message = string | number | { key: string; values: Message[] };
let language: Language = "en";

export function getLanguage(): Language {
  return language;
}

export function message(key: string, ...values: Message[]): Message {
  return { key, values };
}

/** Translate at presentation time so stored statuses follow language changes. */
export function translate(source: Message): string {
  return formatMessage(source, language);
}

function formatMessage(source: Message, locale: Language): string {
  if (typeof source === "number") return String(source);
  const key = typeof source === "string" ? source : source.key;
  const index = languages.indexOf(locale) - 1;
  const translated = index < 0 ? key : translations[key]?.[index] ?? key;
  if (typeof source === "string") return translated;
  return translated.replace(/\{(\d+)\}/g, (_, index: string) =>
    formatMessage(source.values[Number(index)] ?? "", locale));
}

/** Keep diagnostic error text in English and retain its localizable UI message. */
export class MessageError extends Error {
  readonly source: Message;
  constructor(source: Message) {
    super(formatMessage(source, "en"));
    this.source = source;
  }
}

export function errorMessage(error: unknown): Message {
  return error instanceof MessageError ? error.source
    : error instanceof Error ? error.message : String(error);
}

export function t(key: string, ...values: Message[]): string {
  return translate(message(key, ...values));
}

export function setLanguage(value: string): void {
  language = languages.find(item => item === value) ?? "en";
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Embedded browsers can deny storage; selection still works for this visit.
  }
}

export function restoreLanguage(): void {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    language = languages.find(item => item === saved) ?? "en";
  } catch {
    language = "en";
  }
}

const dateFormats = new Map<Language, Intl.DateTimeFormat>();
export function formatSkyTime(date: Date): string {
  let format = dateFormats.get(language);
  if (!format) {
    format = new Intl.DateTimeFormat(language === "en" ? "en-GB" : language, {
      year: "numeric", month: "short", day: "numeric", hour: "2-digit",
      minute: "2-digit", timeZoneName: "short",
    });
    dateFormats.set(language, format);
  }
  return format.format(date);
}
