import { access, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const MIB = 1024 * 1024;
const TOTAL_PACKAGE_BUDGET = Math.floor(1.25 * MIB);
// Bundle sizes remain visible in the audit report, but are advisory. Product
// acceptance is based on runtime behavior, security boundaries and measured
// responsiveness rather than a fixed package-size gate.
const BRIDGE_BACKGROUND_BUDGET = 204 * 1024;
const BRIDGE_BACKGROUND_GZIP_BUDGET = 60 * 1024;
const ENTERPRISE_BACKGROUND_GZIP_BUDGET = 61 * 1024;
const CHROMIUM_EXTENSION_ID = 'mcnaombmlombekhbonfndagbcfhmoail';
// Recorder, callable registry and Pipeline runtime are installed only for an
// explicitly selected document. Keep their budget separate from the always-on
// Service Worker so moving work out of startup code remains measurable.
const MAIN_WORLD_PIPELINE_BUDGET = 36 * 1024;
const FIXTURE_LEAK_SIGNATURES = [
  '127.0.0.1:82',
  '192.168.3.3:8080',
  '/encrypt/aes.php',
  '/encrypt/rsa.php',
  '/semantic-adapter-submit',
  '/opaque-worker-submit',
  'recorder-webcrypto-envelope-474',
  'worker-boundary-holdout-811',
  'semantic-sm-plaintext-821',
  'semantic-forge-plaintext-822',
  'module-recording-',
  '"password":"123456"',
];

const targets = [
  { name: 'store', dir: '.output/chrome-mv3-store', contentBudget: 12 * 1024, backgroundBudget: BRIDGE_BACKGROUND_BUDGET, backgroundGzipBudget: BRIDGE_BACKGROUND_GZIP_BUDGET, totalBudget: TOTAL_PACKAGE_BUDGET, directEval: false, userScripts: true, execution: 'user-scripts' },
  { name: 'enterprise', dir: '.output/chrome-mv3-enterprise', contentBudget: 16 * 1024, backgroundBudget: BRIDGE_BACKGROUND_BUDGET, backgroundGzipBudget: ENTERPRISE_BACKGROUND_GZIP_BUDGET, totalBudget: TOTAL_PACKAGE_BUDGET, directEval: true, userScripts: true, execution: 'user-scripts+injected-fallback' },
  { name: 'firefox', dir: '.output/firefox-mv2', contentBudget: 16 * 1024, backgroundBudget: BRIDGE_BACKGROUND_BUDGET, backgroundGzipBudget: BRIDGE_BACKGROUND_GZIP_BUDGET, totalBudget: TOTAL_PACKAGE_BUDGET, directEval: true, userScripts: false, execution: 'injected-bridge' },
  { name: 'firefox-amo', dir: '.output/firefox-mv3-store', contentBudget: 12 * 1024, backgroundBudget: BRIDGE_BACKGROUND_BUDGET, backgroundGzipBudget: BRIDGE_BACKGROUND_GZIP_BUDGET, totalBudget: TOTAL_PACKAGE_BUDGET, directEval: false, userScripts: false, execution: 'invoke-only' },
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

async function assertNoFixtureLeakage(path, targetName) {
  const { readdir } = await import('node:fs/promises');
  const findings = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!/\.(?:css|html|js|json|map)$/i.test(entry.name)) continue;
      const source = await readFile(child, 'utf8');
      for (const signature of FIXTURE_LEAK_SIGNATURES) {
        if (source.includes(signature)) findings.push(`${child.slice(path.length + 1)} -> ${signature}`);
      }
    }
  }
  await visit(path);
  assert(findings.length === 0, `${targetName} 生产产物混入靶场 fixture：${findings.join(', ')}`);
}

const report = [];
for (const target of targets) {
  const isFirefox = target.name.startsWith('firefox');
  const output = resolve(root, target.dir);
  assert(await exists(output), `${target.name} 产物不存在，请先运行对应构建命令`);
  await assertNoFixtureLeakage(output, target.name);
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  const contentBytes = await fileSize(join(output, 'content-scripts/agent.js'));
  const backgroundSource = await readFile(join(output, 'background.js'));
  const backgroundBytes = backgroundSource.byteLength;
  const backgroundGzipBytes = gzipSync(backgroundSource).byteLength;
  const recorderBytes = await fileSize(join(output, 'page-recorder-main-world.js'));
  const totalBytes = await directorySize(output);
  const sizeAdvisories = [];
  const directEvalExists = await exists(join(output, 'page-main-world.js'));
  const resources = (manifest.web_accessible_resources || []).flatMap((entry) => typeof entry === 'string' ? [entry] : entry.resources || []);
  const dynamicResourceGroup = (manifest.web_accessible_resources || []).find((entry) => typeof entry !== 'string' && entry.resources?.includes('floating.html'));

  if (!isFirefox) {
    assert(typeof manifest.key === 'string', `${target.name} 缺少固定扩展公钥`);
    const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
    assert(extensionId === CHROMIUM_EXTENSION_ID, `${target.name} 扩展 ID 漂移：${extensionId}`);
  }

  if (contentBytes > target.contentBudget) sizeAdvisories.push(`content script ${contentBytes}B > ${target.contentBudget}B reference`);
  if (backgroundBytes > target.backgroundBudget) sizeAdvisories.push(`background ${backgroundBytes}B > ${target.backgroundBudget}B reference`);
  if (backgroundGzipBytes > target.backgroundGzipBudget) sizeAdvisories.push(`background gzip ${backgroundGzipBytes}B > ${target.backgroundGzipBudget}B reference`);
  if (recorderBytes > MAIN_WORLD_PIPELINE_BUDGET) sizeAdvisories.push(`MAIN-world runtime ${recorderBytes}B > ${MAIN_WORLD_PIPELINE_BUDGET}B reference`);
  if (totalBytes > target.totalBudget) sizeAdvisories.push(`package ${totalBytes}B > ${target.totalBudget}B reference`);
  assert(directEvalExists === target.directEval, `${target.name} page-main-world.js 存在状态不符合构建策略`);
  assert(resources.includes('page-main-world.js') === target.directEval, `${target.name} page-main-world.js 暴露状态不符合构建策略`);
  assert((manifest.permissions || []).includes('userScripts') === target.userScripts, `${target.name} userScripts 权限不符合构建策略`);
  if (target.name === 'store' || target.name === 'firefox-amo') {
    assert(!backgroundSource.toString().includes('(0,eval)'), `${target.name} background 不得包含间接 Eval 实现`);
  }
  assert((manifest.permissions || []).includes('webRequest'), `${target.name} 缺少网络捕获所需 webRequest 权限`);
  assert((manifest.permissions || []).includes('webNavigation'), `${target.name} 缺少 frame/document 生命周期所需 webNavigation 权限`);
  assert((manifest.permissions || []).includes('debugger') === !isFirefox, `${target.name} debugger 权限不符合 Chromium-only 深度捕获策略`);
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
    recorderKiB: Number((recorderBytes / 1024).toFixed(2)),
    totalKiB: Number((totalBytes / 1024).toFixed(2)),
    sizeAdvisories,
    execution: target.execution,
  });
}

console.log(JSON.stringify(report, null, 2));
