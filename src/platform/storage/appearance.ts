import { browser } from 'wxt/browser';

export type ThemePreference = 'system' | 'light' | 'dark';

export const APPEARANCE_STORAGE_KEY = 'settings.appearance.v1';

interface AppearanceSettings {
  theme: ThemePreference;
}

const DEFAULT_APPEARANCE: AppearanceSettings = { theme: 'system' };

export async function getAppearance(): Promise<AppearanceSettings> {
  const stored = await browser.storage.local.get(APPEARANCE_STORAGE_KEY);
  const value = stored[APPEARANCE_STORAGE_KEY] as AppearanceSettings | undefined;
  return value && ['system', 'light', 'dark'].includes(value.theme) ? value : DEFAULT_APPEARANCE;
}

export async function setThemePreference(theme: ThemePreference): Promise<void> {
  await browser.storage.local.set({ [APPEARANCE_STORAGE_KEY]: { theme } satisfies AppearanceSettings });
}

export function resolveTheme(theme: ThemePreference): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Applies the stored theme to <html data-theme> and keeps it in sync with
 * both the storage key and the OS color scheme. Returns a cleanup function.
 */
export function watchTheme(root: HTMLElement = document.documentElement): () => void {
  const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
  let current: ThemePreference = 'system';
  const apply = () => {
    root.dataset.theme = resolveTheme(current);
  };
  void getAppearance().then((appearance) => {
    current = appearance.theme;
    apply();
  });
  const onStorageChange = (changes: Record<string, unknown>, area: string) => {
    if (area !== 'local' || !(APPEARANCE_STORAGE_KEY in changes)) return;
    const next = (changes[APPEARANCE_STORAGE_KEY] as { newValue?: AppearanceSettings })?.newValue;
    current = next && ['system', 'light', 'dark'].includes(next.theme) ? next.theme : 'system';
    apply();
  };
  const onMediaChange = () => apply();
  browser.storage.onChanged.addListener(onStorageChange);
  media?.addEventListener('change', onMediaChange);
  apply();
  return () => {
    browser.storage.onChanged.removeListener(onStorageChange);
    media?.removeEventListener('change', onMediaChange);
  };
}
