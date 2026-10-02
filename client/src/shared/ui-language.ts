import { englishUi } from './ui-catalog.ts';

export type DisplayLanguage = 'zh-CN' | 'en';
let language: DisplayLanguage = 'zh-CN';
const listeners = new Set<() => void>();
const chineseUi:Readonly<Record<string,string>>={'menu.file':'文件','menu.task':'任务'};

export function getDisplayLanguage(): DisplayLanguage { return language; }
export function subscribeDisplayLanguage(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setDisplayLanguage(next: DisplayLanguage): void {
  if (next !== 'zh-CN' && next !== 'en') throw new Error('Unsupported display language');
  if (next === language) return;
  language = next;
  for (const listener of [...listeners]) listener();
}

/** Translate an explicit product UI key, never an arbitrary message or user name. */
export function uiText(key: string, values: readonly unknown[] = []): string {
  const text = language === 'en' ? (englishUi[key] ?? key) : (chineseUi[key]??key);
  return text.replace(/\{(\d+)\}/gu, (_match, index: string) => String(values[Number(index)]));
}

const localized = new WeakMap<object, object>();
/** Lazy labels in static UI option maps. Keys, numbers, functions, and user data stay untouched. */
export function localizeUi<const T extends object>(value: T): T {
  const cached = localized.get(value);
  if (cached) return cached as T;
  const proxy = new Proxy(value, {
    get(target, property, receiver) {
      const item: unknown = Reflect.get(target, property, receiver);
      return typeof item === 'string' ? uiText(item)
        : item && typeof item === 'object' ? localizeUi(item) : item;
    },
  });
  localized.set(value, proxy);
  return proxy;
}
