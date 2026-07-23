import type { ActiveTabInfo, ExtensionState } from '@/types/models';

export type ProxyRunTask = (task: () => Promise<void>, success?: string) => Promise<void>;

export interface ProxyViewProps {
  state: ExtensionState;
  setState: (state: ExtensionState) => void;
  run: ProxyRunTask;
  busy: boolean;
  tab?: ActiveTabInfo;
}
