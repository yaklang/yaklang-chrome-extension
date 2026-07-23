import type { BrowserBusinessFrameHint, BrowserDeepCaptureFrame, BrowserDeepCapturePause } from '@/types/models';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const EVENT_HANDLER_NAME = /^on(?:abort|beforeinput|blur|change|click|close|contextmenu|dblclick|error|focus|input|keydown|keypress|keyup|load|mousedown|mouseenter|mouseleave|mousemove|mouseout|mouseover|mouseup|pointer|reset|resize|scroll|submit|touch|unload|wheel)/i;
const TRANSACTION_RISKS = new Set(['network', 'dom', 'navigation']);

export interface RankedBusinessFrames {
  frames: BrowserDeepCaptureFrame[];
  recommendedFrameId?: string;
  automaticCapture: NonNullable<BrowserDeepCapturePause['automaticCapture']>;
}

function comparableUrl(value?: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

function nameMatches(frameName: string, hintName: string): boolean {
  return frameName === hintName || frameName.endsWith(`.${hintName}`) || hintName.endsWith(`.${frameName}`);
}

function matchingHint(frame: BrowserDeepCaptureFrame, hints: BrowserBusinessFrameHint[]): BrowserBusinessFrameHint | undefined {
  return hints.find((hint) => nameMatches(frame.functionName, hint.functionName)
    && (!hint.url || comparableUrl(frame.url) === comparableUrl(hint.url)));
}

function isEventHandler(frame: BrowserDeepCaptureFrame): boolean {
  if (EVENT_HANDLER_NAME.test(frame.functionName)) return true;
  const parameters = frame.functionInspection?.parameterNames || [];
  return parameters.some((name) => /^(?:event|evt)$/i.test(name))
    && /(?:Element|Document|Window)/.test(frame.thisPreview);
}

function hintedFrameOrder(
  left: BrowserDeepCaptureFrame,
  right: BrowserDeepCaptureFrame,
  hints: BrowserBusinessFrameHint[],
): number {
  const leftHint = matchingHint(left, hints);
  const rightHint = matchingHint(right, hints);
  return (leftHint?.averageDepth ?? Number.POSITIVE_INFINITY) - (rightHint?.averageDepth ?? Number.POSITIVE_INFINITY)
    || left.index - right.index
    || left.id.localeCompare(right.id);
}

function rankFrame(frame: BrowserDeepCaptureFrame, hints: BrowserBusinessFrameHint[]): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  if (frame.sourceKind === 'extension-hook') return { score: 0, reasons: ['插件观测帧已排除'] };
  if (frame.sourceKind === 'page') {
    score += 42;
    reasons.push('页面自身代码');
  } else {
    score += 8;
    reasons.push('第三方依赖代码');
  }

  const proximity = Math.max(0, 18 - frame.index * 2);
  score += proximity;
  if (proximity >= 10) reasons.push('靠近目标边界');

  const inspection = frame.functionInspection;
  if (inspection?.resolved) {
    score += 14;
    reasons.push('函数引用可解析');
  }
  const risks = inspection?.riskFlags || [];
  if (!risks.length && inspection?.resolved) {
    score += 12;
    reasons.push('未发现明显副作用');
  } else {
    if (risks.includes('network')) score -= 24;
    if (risks.includes('navigation')) score -= 22;
    if (risks.includes('dom')) score -= 12;
    if (risks.includes('storage')) score -= 5;
    if (risks.length) reasons.push('包含可见副作用');
  }

  if (IDENTIFIER.test(frame.functionName) && frame.functionName !== '(anonymous)') {
    score += frame.functionName.length <= 2 ? 2 : 9;
    reasons.push(frame.functionName.length <= 2 ? '名称已混淆' : '具名业务函数');
  }

  const localVariables = frame.scopes
    .filter((scope) => scope.type === 'local' || scope.type === 'closure')
    .reduce((count, scope) => count + scope.variables.length, 0);
  if (localVariables) {
    score += Math.min(10, Math.ceil(localVariables / 3));
    reasons.push('具有可分析参数或闭包现场');
  }

  const hint = matchingHint(frame, hints);
  if (hint) {
    score += Math.min(28, 16 + hint.support * 4);
    reasons.push(hint.support > 1 ? `${hint.support} 个密码调用的共同业务祖先` : '录制调用栈中的业务祖先');
  }

  return { score: Math.max(0, Math.min(100, score)), reasons: reasons.slice(0, 6) };
}

export function rankBusinessFrames(
  frames: BrowserDeepCaptureFrame[],
  hints: BrowserBusinessFrameHint[] = [],
): RankedBusinessFrames {
  const ranked = frames.map((frame) => {
    const rank = rankFrame(frame, hints);
    return { ...frame, businessScore: rank.score, businessReasons: rank.reasons };
  });
  const ordered = ranked
    .filter((frame) => frame.sourceKind === 'page' && (frame.businessScore || 0) >= 40)
    .sort((left, right) => (right.businessScore || 0) - (left.businessScore || 0)
      || left.index - right.index
      || left.id.localeCompare(right.id));
  const recommended = ordered[0];
  const resolvedHinted = ranked
    .filter((frame) => frame.sourceKind === 'page' && frame.functionInspection?.resolved && matchingHint(frame, hints))
    .sort((left, right) => hintedFrameOrder(left, right, hints));
  const closestHinted = resolvedHinted[0];
  const closestRisks = closestHinted?.functionInspection?.riskFlags || [];
  const transactionRequired = Boolean(closestHinted
    && (isEventHandler(closestHinted) || closestRisks.some((risk) => TRANSACTION_RISKS.has(risk))));
  const transactionBlocked = Boolean(transactionRequired && closestRisks.includes('storage'));
  const eligible = ordered.filter((frame) => frame.functionInspection?.resolved
    && !frame.functionInspection.riskFlags.length && !isEventHandler(frame));
  const automaticEligible = hints.length
    ? eligible.filter((frame) => Boolean(matchingHint(frame, hints)))
    : eligible;
  const automatic = automaticEligible[0];
  const alternative = automaticEligible[1];
  let automaticCapture: RankedBusinessFrames['automaticCapture'];
  if (transactionRequired && !transactionBlocked && closestHinted) {
    automaticCapture = {
      state: 'ready',
      strategy: 'request-transaction',
      frameId: closestHinted.id,
      reason: isEventHandler(closestHinted)
        ? '共同业务入口是页面事件处理器，将在隔离事务中截获并取消真实请求'
        : '共同业务函数直接读取页面或发送请求，将以隔离事务保留完整动态参数关系',
    };
  } else if (transactionBlocked && closestHinted) {
    automaticCapture = {
      state: 'blocked',
      frameId: closestHinted.id,
      reason: '共同业务函数会访问页面存储；当前事务回滚无法证明存储副作用已完全隔离',
    };
  } else if (automatic && alternative && (automatic.businessScore || 0) - (alternative.businessScore || 0) < 8) {
    automaticCapture = {
      state: 'ambiguous',
      reason: '发现多个证据接近的可复用页面函数，需要确认业务边界',
      frameId: automatic.id,
      alternativeFrameIds: eligible.slice(0, 4).map((frame) => frame.id),
    };
  } else if (automatic) {
    automaticCapture = {
      state: 'ready',
      strategy: 'selected-frame',
      frameId: automatic.id,
      reason: matchingHint(automatic, hints)
        ? '已用录制调用栈与暂停现场共同确认业务函数'
        : '已定位唯一且未发现明显副作用的页面函数',
    };
  } else if (recommended?.functionInspection?.riskFlags.length) {
    automaticCapture = {
      state: 'blocked',
      frameId: recommended.id,
      reason: '最接近的业务函数会产生网络、DOM、导航或存储副作用，已阻止自动回放',
    };
  } else {
    automaticCapture = {
      state: 'unavailable',
      frameId: recommended?.id,
      reason: hints.length && eligible.length
        ? '录制调用栈提示没有与暂停现场唯一对应，已停止自动选择'
        : recommended
        ? '业务栈帧存在，但浏览器无法唯一解析其函数对象'
        : '当前调用栈没有可复用的页面业务函数',
    };
  }
  return { frames: ranked, recommendedFrameId: automaticCapture.frameId || recommended?.id, automaticCapture };
}
