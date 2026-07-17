import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browser } from 'wxt/browser';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FloatingPanel } from '@/features/floating-panel/FloatingPanel';
import type { ActiveTabInfo, BridgeStatus, ExtensionState } from '@/types/models';
import { request } from '@/platform/messaging/runtime';
import { watchTheme } from '@/platform/storage/appearance';
import '@/styles/global.css';
import '../agent.content/style.css';
import './style.css';

watchTheme();

function FloatingApp() {
  const [initial, setInitial] = useState<{ state: ExtensionState; tab?: ActiveTabInfo; bridge: BridgeStatus }>();
  const [error, setError] = useState('');

  useEffect(() => {
    const tabId = Number(new URLSearchParams(location.search).get('tabId'));
    void Promise.all([
      request('state.get'),
      Number.isSafeInteger(tabId) && tabId > 0
        ? request('tab.get', { tabId }).catch(() => undefined)
        : Promise.resolve(undefined),
      request('bridge.status'),
    ]).then(([state, tab, bridge]) => setInitial({ state, tab, bridge }))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  if (error) return <div className="floating-frame-error">{error}</div>;
  if (!initial) return <div className="floating-frame-loading">正在加载</div>;
  return (
    <FloatingPanel
      initialState={initial.state}
      initialTab={initial.tab}
      initialBridge={initial.bridge}
      yakIconUrl={browser.runtime.getURL('/yak.svg')}
      embedded
    />
  );
}

createRoot(document.getElementById('app')!).render(
  <TooltipProvider delayDuration={350}><FloatingApp /></TooltipProvider>,
);
