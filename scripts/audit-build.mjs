import { access, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const MIB = 1024 * 1024;
// Extension Service Workers do not support runtime import(). Bridge v3 identity verification must stay in the startup bundle.
const BRIDGE_BACKGROUND_BUDGET = 144 * 1024;
const BRIDGE_BACKGROUND_GZIP_BUDGET = 44 * 1024;

const targets = [
  { name: 'store', dir: '.output/chrome-mv3-store', contentBudget: 12 * 1024, backgroundBudget: BRIDGE_BACKGROUND_BUDGET, backgroundGzipBudget: BRIDGE_BACKGROUND_GZIP_BUDGET, totalBudget: MIB, directEval: false, userScripts: true, execution: 'user-scripts' },
  { name: 'enterprise', dir: '.output/chrome-mv3-enterprise', contentBudget: 16 * 1024, backgroundBudget: BRIDGE_BACKGROUND_BUDGET, backgroundGzipBudget: BRIDGE_BACKGROUND_GZIP_BUDGET, totalBudget: MIB, directEval: true, userScripts: true, execution: 'user-scripts+injected-fallback' },
  { name: 'firefox', dir: '.output/firefox-mv2', contentBudget: 16 * 1024, backgroundBudget: BRIDGE_BACKGROUND_BUDGET, backgroundGzipBudget: BRIDGE_BACKGROUND_GZIP_BUDGET, totalBudget: MIB, directEval: true, userScripts: false, execution: 'injected-bridge' },
  { name: 'firefox-amo', dir: '.output/firefox-mv3-store', contentBudget: 12 * 1024, backgroundBudget: BRIDGE_BACKGROUND_BUDGET, backgroundGzipBudget: BRIDGE_BACKGROUND_GZIP_BUDGET, totalBudget: MIB, directEval: false, userScripts: false, execution: 'invoke-only' },
];

async function fileSize(path) {
  return (await stat(path)).size;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function directorySize(path) {
  const { readdir } = await import('node:fs/promises');
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? await directorySize(child) : await fileSize(child);
  }
  return total;
}

const report = [];
for (const target of targets) {
  const isFirefox = target.name.startsWith('firefox');
  const output = resolve(root, target.dir);
  assert(await exists(output), `${target.name} 产物不存在，请先运行对应构建命令`);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  const contentBytes = await fileSize(join(output, 'content-scripts/agent.js'));
  const backgroundSource = await readFile(join(output, 'background.js'));
  const backgroundBytes = backgroundSource.byteLength;
  const backgroundGzipBytes = gzipSync(backgroundSource).byteLength;
  const observerBytes = await fileSize(join(output, 'page-observer-main-world.js'));
  const totalBytes = await directorySize(output);
  const directEvalExists = await exists(join(output, 'page-main-world.js'));
  const resources = (manifest.web_accessible_resources || []).flatMap((entry) => typeof entry === 'string' ? [entry] : entry.resources || []);
  const dynamicResourceGroup = (manifest.web_accessible_resources || []).find((entry) => typeof entry !== 'string' && entry.resources?.includes('floating.html'));

  assert(contentBytes <= target.contentBudget, `${target.name} 常驻 content script ${contentBytes}B 超过预算 ${target.contentBudget}B`);
  assert(backgroundBytes <= target.backgroundBudget, `${target.name} background ${backgroundBytes}B 超过 ${target.backgroundBudget / 1024}KiB 原始预算`);
  assert(backgroundGzipBytes <= target.backgroundGzipBudget, `${target.name} background gzip ${backgroundGzipBytes}B 超过 ${target.backgroundGzipBudget / 1024}KiB 预算`);
  assert(observerBytes <= 12 * 1024, `${target.name} MAIN-world observer ${observerBytes}B 超过 12KiB 预算`);
  assert(totalBytes <= target.totalBudget, `${target.name} 总产物 ${totalBytes}B 超过 ${target.totalBudget / MIB}MiB 预算`);
  assert(directEvalExists === target.directEval, `${target.name} page-main-world.js 存在状态不符合构建策略`);
  assert(resources.includes('page-main-world.js') === target.directEval, `${target.name} page-main-world.js 暴露状态不符合构建策略`);
  assert((manifest.permissions || []).includes('userScripts') === target.userScripts, `${target.name} userScripts 权限不符合构建策略`);
  if (target.name === 'store' || target.name === 'firefox-amo') {
    assert(!backgroundSource.toString().includes('(0,eval)'), `${target.name} background 不得包含间接 Eval 实现`);
  }
  assert((manifest.permissions || []).includes('webRequest'), `${target.name} 缺少网络捕获所需 webRequest 权限`);
  assert((manifest.permissions || []).includes('webNavigation'), `${target.name} 缺少 frame/document 生命周期所需 webNavigation 权限`);
  assert(!(manifest.permissions || []).includes('activeTab'), `${target.name} 不应申请未使用的 activeTab 权限`);
  assert(!(manifest.permissions || []).includes('nativeMessaging') && (manifest.optional_permissions || []).includes('nativeMessaging'), `${target.name} Native Messaging 必须按需授权`);
  assert((manifest.permissions || []).includes(isFirefox ? 'webRequestBlocking' : 'webRequestAuthProvider'), `${target.name} 缺少代理认证权限`);
  assert(manifest.storage?.managed_schema === 'managed-storage-schema.json', `${target.name} 缺少企业 managed storage schema`);
  assert(await exists(join(output, 'managed-storage-schema.json')), `${target.name} managed storage schema 未打包`);
  if (!isFirefox) assert(!(manifest.permissions || []).includes('webRequestBlocking'), `${target.name} 不应申请阻断或修改网络请求的 webRequestBlocking 权限`);
  assert(resources.includes('floating.html'), `${target.name} 没有公开按需浮动页`);
  if (manifest.manifest_version === 3) assert(dynamicResourceGroup?.use_dynamic_url === true, `${target.name} 浮动页必须使用动态资源 URL`);

  report.push({
    target: target.name,
    contentScriptKiB: Number((contentBytes / 1024).toFixed(2)),
    backgroundKiB: Number((backgroundBytes / 1024).toFixed(2)),
    backgroundGzipKiB: Number((backgroundGzipBytes / 1024).toFixed(2)),
    observerKiB: Number((observerBytes / 1024).toFixed(2)),
    totalKiB: Number((totalBytes / 1024).toFixed(2)),
    execution: target.execution,
  });
}

console.log(JSON.stringify(report, null, 2));
