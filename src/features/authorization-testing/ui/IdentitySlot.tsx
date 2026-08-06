import type { ActiveTabInfo, BrowserIsolationContext } from '@/types/models';

function shortPageAddress(tab: ActiveTabInfo): string {
  try {
    const parsed = new URL(tab.url);
    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return tab.url;
  }
}

function contextKindLabel(
  context: BrowserIsolationContext | undefined,
  selectedTab: ActiveTabInfo | undefined,
): string {
  if (!selectedTab) return '等待选择页面';
  switch (context?.kind) {
    case 'chrome-incognito-store': return '无痕隔离上下文';
    case 'firefox-container':
      return context.containerName ? `Container · ${context.containerName}` : 'Container 隔离上下文';
    case 'managed-ephemeral-profile': return '独立浏览器 Profile';
    case 'verified-tab-local': return '标签页局部上下文';
    case 'sequential-auth-snapshot': return '顺序身份快照';
    default: return selectedTab.incognito ? '无痕浏览上下文' : '普通浏览上下文';
  }
}

function windowKindLabel(tab: ActiveTabInfo): string {
  return tab.incognito ? '无痕窗口' : '普通窗口';
}

export function IdentitySlot({
  side, title, label, setLabel, tabId, setTabId, tabs, context, disabledReason, emptyHint,
}: {
  side: 'A' | 'B';
  title: string;
  label: string;
  setLabel: (value: string) => void;
  tabId?: number;
  setTabId: (value: number | undefined) => void;
  tabs: ActiveTabInfo[];
  context?: BrowserIsolationContext;
  disabledReason: (tab: ActiveTabInfo) => string | undefined;
  emptyHint: string;
}) {
  const selectedTab = tabs.find((item) => item.id === tabId);
  return <div className={`authorization-identity-slot ${selectedTab ? 'is-selected' : 'is-empty'}`}>
    <header><span>{side}</span><div><strong>{title}</strong><small>{contextKindLabel(context, selectedTab)}</small></div></header>
    <label><span>账号备注</span><input value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder={side === 'A' ? '例如：普通用户' : '例如：另一个用户'} /></label>
    <label><span>{side === 'A' ? '当前已登录页面' : '另一个已登录页面'}</span><select
      aria-label={`身份 ${side} 的已登录页面`}
      value={selectedTab?.id || ''}
      onChange={(event) => setTabId(event.target.value ? Number(event.target.value) : undefined)}
    >
      <option value="">{side === 'A' ? '选择当前登录页面' : '选择页面，或在中间创建隔离身份'}</option>
      {tabs.map((item) => {
        const reason = disabledReason(item);
        return <option value={item.id} key={item.id} disabled={Boolean(reason)}>
          {item.title} · {shortPageAddress(item)} · {windowKindLabel(item)}{reason ? ` · ${reason}` : ''}
        </option>;
      })}
    </select></label>
    <div className="authorization-identity-meta">
      <span><i className={context?.level || ''} />{selectedTab
        ? context?.level === 'strong'
          ? '强隔离上下文'
          : context?.level === 'conditional'
            ? '条件隔离上下文'
            : '隔离待验证'
        : '尚未选择页面'}</span>
      <code title={selectedTab?.url || emptyHint}>
        {selectedTab ? `${windowKindLabel(selectedTab)} · ${selectedTab.url}` : emptyHint}
      </code>
    </div>
  </div>;
}
