import type { ActiveTabInfo, BrowserAuthorizationInstance } from '@/types/models';

function shortPageAddress(tab: ActiveTabInfo): string {
  try {
    const parsed = new URL(tab.url);
    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return tab.url;
  }
}

export function IdentitySlot({
  side, title, label, setLabel, instance, instances, setInstanceId, tabId, setTabId,
}: {
  side: 'A' | 'B';
  title: string;
  label: string;
  setLabel: (value: string) => void;
  instance?: BrowserAuthorizationInstance;
  instances: BrowserAuthorizationInstance[];
  setInstanceId?: (value: string) => void;
  tabId?: number;
  setTabId: (value: number | undefined) => void;
}) {
  const selectedTab = instance?.tabs.find((item) => item.id === tabId);
  return <div className={`authorization-identity-slot ${selectedTab ? 'is-selected' : 'is-empty'}`}>
    <header>
      <span>{instance?.badge || side}</span>
      <div>
        <strong>{title}</strong>
        <small>{instance ? `YTray 浏览器 ${instance.badge} · 在线` : '等待在线浏览器'}</small>
      </div>
    </header>
    <label>
      <span>账号备注</span>
      <input value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder={side === 'A' ? '例如：资源所有者' : '例如：对照账号'} />
    </label>
    {setInstanceId && <label>
      <span>浏览器实例</span>
      <select aria-label={`身份 ${side} 的浏览器实例`} value={instance?.deviceId || ''} onChange={(event) => setInstanceId(event.target.value)}>
        <option value="">选择另一个在线实例</option>
        {instances.filter((item) => !item.current).map((item) => <option value={item.deviceId} key={item.deviceId}>
          浏览器 {item.badge} · {item.tabs.length} 个页面
        </option>)}
      </select>
    </label>}
    <label>
      <span>已登录页面</span>
      <select
        aria-label={`身份 ${side} 的已登录页面`}
        value={selectedTab?.id || ''}
        disabled={!instance}
        onChange={(event) => setTabId(event.target.value ? Number(event.target.value) : undefined)}
      >
        <option value="">{instance ? '选择 HTTP(S) 页面' : '先选择浏览器实例'}</option>
        {instance?.tabs.map((item) => <option value={item.id} key={item.id}>
          {item.title || '未命名页面'} · {shortPageAddress(item)}
        </option>)}
      </select>
    </label>
    <div className="authorization-identity-meta">
      <span><i className={instance ? 'strong' : ''} />{instance ? '独立浏览器 Profile' : '尚未选择实例'}</span>
      <code title={selectedTab?.url || instance?.error || ''}>
        {selectedTab?.url || instance?.error || '请先在该浏览器打开并登录目标站点'}
      </code>
    </div>
  </div>;
}
