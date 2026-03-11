import { en } from './locales/en';
import { zh } from './locales/zh';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { de } from './locales/de';

export type Language = 'en' | 'zh' | 'ja' | 'ko' | 'es' | 'fr' | 'de';

export const translations: Record<Language, Record<string, string>> = {
  en,
  zh,
  ja,
  ko,
  es,
  fr,
  de,
};
