import type { BackgroundRequestHandler } from '../router';
import { ok } from '../response';
import {
  applyProxyRules,
  clearCurrentSiteRoute,
  compileCurrentProxyRules,
  dirtyProxyState,
  exportProxyConfiguration,
  getProxyRuleSourcePage,
  hasProxyAuthPassword,
  importProxyConfiguration,
  previewCurrentProxyRules,
  refreshProxyRuleSource,
  removeProxyProfile,
  removeProxyRuleSource,
  routeCurrentSite,
  saveProxyProfile,
  saveProxyRuleSource,
  setProxyAuthPassword,
  switchProxy,
} from '@/features/proxy/service';
import { updateState } from '@/platform/storage/state';

export const handleProxyRequest: BackgroundRequestHandler = async (request) => {
  switch (request.action) {
    case 'proxy.save': return ok(await saveProxyProfile(request.payload));
    case 'proxy.delete': return ok(await removeProxyProfile(request.payload.id));
    case 'proxy.switch': return ok(await switchProxy(request.payload.id));
    case 'proxy.rule.save': {
      const rule = request.payload;
      return ok(await updateState((state) => {
        if (!state.proxyProfiles.some((profile) => profile.id === rule.proxyProfileId
          && ['direct', 'fixed_servers'].includes(profile.kind))) {
          throw new Error('规则 PAC 只能使用直接连接或固定代理出口');
        }
        return dirtyProxyState({
          ...state,
          proxyRules: [...state.proxyRules.filter((item) => item.id !== rule.id), rule],
        });
      }));
    }
    case 'proxy.rule.delete': {
      const { id } = request.payload;
      return ok(await updateState((state) => dirtyProxyState({
        ...state,
        proxyRules: state.proxyRules.filter((item) => item.id !== id),
      })));
    }
    case 'proxy.auto.apply': return ok(await applyProxyRules());
    case 'proxy.rules.preview': return ok(await previewCurrentProxyRules(request.payload.url));
    case 'proxy.rules.compile': return ok(await compileCurrentProxyRules());
    case 'proxy.rules.reorder': {
      const ids = request.payload.ids;
      return ok(await updateState((current) => {
        if (ids.length !== current.proxyRules.length || new Set(ids).size !== ids.length
          || ids.some((id) => !current.proxyRules.some((rule) => rule.id === id))) {
          throw new Error('规则排序必须包含当前全部规则且不能重复');
        }
        const byId = new Map(current.proxyRules.map((rule) => [rule.id, rule]));
        return dirtyProxyState({
          ...current,
          proxyRules: ids.map((id, order) => ({
            ...byId.get(id)!, order, updatedAt: Date.now(),
          })),
        });
      }));
    }
    case 'proxy.rules.settings': {
      const input = request.payload;
      return ok(await updateState((current) => {
        if (!current.proxyProfiles.some((profile) => profile.id === input.defaultProfileId
          && ['direct', 'fixed_servers'].includes(profile.kind))) {
          throw new Error('默认出口必须是直接连接或固定代理');
        }
        return dirtyProxyState({ ...current, proxyRouting: input });
      }));
    }
    case 'proxy.source.save': return ok(await saveProxyRuleSource(request.payload));
    case 'proxy.source.refresh': return ok(await refreshProxyRuleSource(request.payload.id));
    case 'proxy.source.delete': return ok(await removeProxyRuleSource(request.payload.id));
    case 'proxy.sources.reorder': {
      const ids = request.payload.ids;
      return ok(await updateState((current) => {
        if (ids.length !== current.proxyRuleSources.length || new Set(ids).size !== ids.length
          || ids.some((id) => !current.proxyRuleSources.some((source) => source.id === id))) {
          throw new Error('规则源排序必须包含当前全部订阅且不能重复');
        }
        const byId = new Map(current.proxyRuleSources.map((source) => [source.id, source]));
        return dirtyProxyState({
          ...current,
          proxyRuleSources: ids.map((id, order) => ({ ...byId.get(id)!, order })),
        });
      }));
    }
    case 'proxy.source.rules': return ok(await getProxyRuleSourcePage(
      request.payload.id,
      request.payload.offset,
      request.payload.limit,
      request.payload.query,
    ));
    case 'proxy.site.route': return ok(await routeCurrentSite(
      request.payload.url,
      request.payload.profileId,
    ));
    case 'proxy.site.route.clear': return ok(await clearCurrentSiteRoute(request.payload.url));
    case 'proxy.auth.set':
      await setProxyAuthPassword(request.payload.profileId, request.payload.password);
      return ok({ configured: hasProxyAuthPassword(request.payload.profileId) });
    case 'proxy.auth.status': return ok({
      configured: hasProxyAuthPassword(request.payload.profileId),
    });
    case 'proxy.config.export': return ok(await exportProxyConfiguration());
    case 'proxy.config.import': return ok(await importProxyConfiguration(request.payload.configuration));
    default: return undefined;
  }
};
