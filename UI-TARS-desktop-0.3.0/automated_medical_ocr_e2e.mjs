import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = 'D:/uv/uitars/ui_tars_all';
const output = path.resolve(process.env.MEDICAL_OCR_OUTPUT_DIR || path.join(root, 'screenshots', 'automated-medical-20261006'));
const rosterPath = path.resolve(process.env.MEDICAL_ROSTER || path.join(root, 'demo_名单.csv'));
const settingsPath = path.resolve(process.env.UI_TARS_SETTINGS || path.join(root, 'model_settings.local.json'));
const appUrl = process.env.MEDICAL_APP_URL || 'http://127.0.0.1:8765';
const recoveryEnabled = process.env.UI_TARS_AI_RECOVERY !== '0';
const demoFault = process.env.MEDICAL_DEMO_FAULT || '';
const demoCloseStage = process.env.MEDICAL_DEMO_CLOSE_STAGE || '';
const resumeEnabled = process.env.MEDICAL_RESUME !== '0';
let demoFaultInjected = false;
const maxBrowserRestarts = Math.max(Number(process.env.MEDICAL_MAX_BROWSER_RESTARTS || 3), 0);
const session = { browser: null, page: null, restarts: 0 };

function waitMs(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function browserUnavailable() {
  return !session.browser || !session.browser.isConnected() || !session.page || session.page.isClosed();
}

async function closeBrowserSession() {
  try {
    if (session.browser) await session.browser.close();
  } catch {
    // The browser may already have been closed by a human.
  } finally {
    session.browser = null;
    session.page = null;
  }
}

async function openAndLogin() {
  const browser = await chromium.launch({
    headless: false,
    executablePath: 'C:/Users/musi/AppData/Local/Google/Chrome/Application/chrome.exe',
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    await page.goto(appUrl, { waitUntil: 'networkidle' });
    if ((demoFault === 'close-browser-startup' || demoCloseStage === 'startup') && !demoFaultInjected) {
      demoFaultInjected = true;
      console.log('[demo fault] 模拟登录阶段人工关闭浏览器，准备触发启动重试');
      await browser.close();
    }
    await showAiActivity(page, 'AI 正在操作');
    await page.locator('#username').fill('demo');
    await page.locator('#password').fill('demo');
    await page.getByRole('button', { name: '登录病例工作台' }).click();
    await expect(page.locator('#app-panel')).toBeVisible();
    return { browser, page };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

async function startBrowserSession() {
  let lastError;
  for (let attempt = 0; attempt <= maxBrowserRestarts; attempt += 1) {
    try {
      const opened = await openAndLogin();
      session.browser = opened.browser;
      session.page = opened.page;
      if (attempt > 0) console.log(`[browser-supervisor] 启动阶段第 ${attempt} 次重试成功`);
      return;
    } catch (error) {
      lastError = error;
      await closeBrowserSession();
      if (attempt >= maxBrowserRestarts) break;
      session.restarts += 1;
      console.log(`[browser-supervisor] 启动/登录失败，第 ${session.restarts}/${maxBrowserRestarts} 次重试：${error.message}`);
      await waitMs(1000);
    }
  }
  throw new Error(`浏览器启动或登录失败，已重试 ${maxBrowserRestarts} 次：${lastError?.message || lastError}`);
}

async function restoreBrowserSession(patient, checkpointName, reason) {
  if (session.restarts >= maxBrowserRestarts) {
    throw new Error(`浏览器已关闭，连续自动重启达到上限 ${maxBrowserRestarts} 次：${reason.message || reason}`);
  }
  session.restarts += 1;
  console.log(`[browser-supervisor] 检测到浏览器已关闭，第 ${session.restarts}/${maxBrowserRestarts} 次重启`);
  await closeBrowserSession();
  const opened = await openAndLogin();
  session.browser = opened.browser;
  session.page = opened.page;

  const page = session.page;
  await page.locator('#search-input').fill(patient.patient_id);
  await page.getByRole('button', { name: '应用筛选' }).click();
  const card = page.locator('.result-card').filter({ hasText: patient.patient_id });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText(patient.name);
  await expect(card).toContainText(patient.birth_date);

  if (checkpointName !== '搜索患者') {
    await card.getByRole('button', { name: '进入病历' }).click();
    const details = page.locator('#details');
    await expect(details).toBeVisible();
    await expect(details.locator('h2')).toContainText(patient.patient_id);
    await expect(details).toContainText(patient.name);
    await expect(details).toContainText(patient.birth_date);
    if (checkpointName === '展开病历' || checkpointName === '逐份截图') {
      const expand = page.getByRole('button', { name: '展开全部记录' });
      if (await expand.count()) await expand.click();
    }
  }
  console.log(`[browser-supervisor] 已恢复到检查点“${checkpointName}”：${patient.patient_id}`);
}

async function preparePatientPage(patient) {
  if (browserUnavailable()) {
    await restoreBrowserSession(patient, '搜索患者', new Error('人工关闭了浏览器'));
  }
  try {
    await showAiActivity(session.page, `AI 正在操作 · ${patient.name}`);
  } catch (error) {
    if (!browserUnavailable()) throw error;
    await restoreBrowserSession(patient, '搜索患者', error);
    await showAiActivity(session.page, `AI 正在操作 · ${patient.name}`);
  }
}

function readRoster(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).slice(1).map((line) => {
    const [task_id, name, patient_id, birth_date] = line.split(',');
    return { task_id, name, patient_id, birth_date };
  });
}

const roster = readRoster(rosterPath);
fs.mkdirSync(output, { recursive: true });

async function showAiActivity(page, message) {
  await page.evaluate((label) => {
    let style = document.querySelector('#ai-activity-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'ai-activity-style';
      style.textContent = `
        #ai-activity-light { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;
          background: linear-gradient(to right, rgba(30,144,255,.4),transparent 50%) left,
            linear-gradient(to left,rgba(30,144,255,.4),transparent 50%) right,
            linear-gradient(to bottom,rgba(30,144,255,.4),transparent 50%) top,
            linear-gradient(to top,rgba(30,144,255,.4),transparent 50%) bottom;
          background-repeat:no-repeat; background-size:10% 100%,10% 100%,100% 10%,100% 10%;
          animation: ai-waterflow 5s cubic-bezier(.4,0,.6,1) infinite; filter:blur(8px); }
        @keyframes ai-waterflow { 0%,100%{transform:scale(1);opacity:.86} 25%,75%{transform:scale(1.03);opacity:.94} 50%{transform:scale(1.05);opacity:1} }
        #ai-activity-badge { position:fixed; top:16px; right:18px; z-index:2147483647; pointer-events:none;
          display:flex;align-items:center;gap:9px;padding:9px 14px;border:1px solid rgba(30,144,255,.55);
          border-radius:999px;background:rgba(10,26,48,.88);color:#eaf5ff;font:600 13px/1.2 system-ui,sans-serif;
          box-shadow:0 0 18px rgba(30,144,255,.45),inset 0 0 12px rgba(30,144,255,.16);backdrop-filter:blur(8px); }
        #ai-activity-badge::before { content:'';width:8px;height:8px;border-radius:50%;background:#1e90ff;
          box-shadow:0 0 10px 3px rgba(30,144,255,.8);animation:ai-dot 1.3s ease-in-out infinite alternate; }
        @keyframes ai-dot { to { opacity:.4;box-shadow:0 0 4px 1px rgba(30,144,255,.6) } }
        @media(prefers-reduced-motion:reduce){#ai-activity-light,#ai-activity-badge::before{animation:none}}
      `;
      document.head.appendChild(style);
    }
    let light = document.querySelector('#ai-activity-light');
    if (!light) { light = document.createElement('div'); light.id = 'ai-activity-light'; document.body.appendChild(light); }
    let badge = document.querySelector('#ai-activity-badge');
    if (!badge) { badge = document.createElement('div'); badge.id = 'ai-activity-badge'; document.body.appendChild(badge); }
    badge.textContent = label;
  }, message);
}

async function injectDemoFault(page, checkpointName) {
  const legacyClose = demoFault === 'close-browser' && checkpointName === '逐份截图';
  const stageClose = (
    (demoCloseStage === 'search' && checkpointName === '搜索患者')
    || (demoCloseStage === 'enter' && checkpointName === '进入病历')
    || (demoCloseStage === 'expand' && checkpointName === '展开病历')
    || (demoCloseStage === 'screenshot' && checkpointName === '逐份截图')
    || (demoCloseStage === 'return' && checkpointName === '返回列表')
  );
  if ((legacyClose || stageClose) && !demoFaultInjected) {
    demoFaultInjected = true;
    console.log('[demo fault] 模拟人工关闭浏览器，准备触发浏览器监督器自动重启');
    await session.browser.close();
    return;
  }
  if (demoFault !== 'popup' || demoFaultInjected || checkpointName !== '进入病历') return;
  demoFaultInjected = true;
  await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'demo-recovery-popup';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483645;background:rgba(0,0,0,.48);display:grid;place-items:center;pointer-events:auto;font:16px system-ui,sans-serif;';
    overlay.innerHTML = '<div style="width:420px;padding:28px;border-radius:14px;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.35);color:#172033"><h3 style="margin:0 0 12px">系统提示</h3><p>演示异常：页面被临时提示遮挡，请关闭后继续当前患者。</p><button id="demo-recovery-close" style="padding:10px 18px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer">关闭提示</button></div>';
    document.body.appendChild(overlay);
    document.querySelector('#demo-recovery-close').addEventListener('click', () => overlay.remove());
  });
  console.log('[demo fault] 已注入会拦截点击的异常弹窗，准备触发 UI-TARS 保底');
}

function runAiRecovery({ patient, checkpoint, error }) {
  if (!recoveryEnabled || !fs.existsSync(settingsPath)) return Promise.resolve(false);
  const recoveryDir = path.join(output, 'ai-recovery');
  fs.mkdirSync(recoveryDir, { recursive: true });
  const stamp = `${Date.now()}`;
  const promptFile = path.join(recoveryDir, `recovery-${stamp}.md`);
  const statusFile = path.join(recoveryDir, `recovery-${stamp}.json`);
  const logFile = path.join(recoveryDir, 'agent.log');
  fs.writeFileSync(promptFile, `
这是一个本地虚构病历系统的异常恢复任务，不要访问外部网站。

当前患者：${patient.patient_id}，姓名：${patient.name}，出生日期：${patient.birth_date}
Playwright 在检查点“${checkpoint}”失败，错误：${String(error?.message || error)}

请通过屏幕截图识别当前界面，并恢复到当前患者的病历页面：
1. 当前患者必须是 ${patient.patient_id}，姓名和出生日期必须匹配。
2. 可以关闭无关弹窗、返回患者列表、重新搜索当前患者并进入病历。
3. 不得修改、删除、提交或导出任何病历内容。
4. 恢复到目标页面后输出 finished()；无法安全恢复时输出 call_user()。
`, 'utf8');

  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn(process.execPath, [
      path.join(root, 'ui_tars_agent_runner.mjs'),
      '--settings', settingsPath,
      '--prompt-file', promptFile,
      '--status-file', statusFile,
      '--screenshot-dir', recoveryDir,
      '--max-loop-count', '12',
    ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.on('close', () => {
      log.end(() => {
        try {
          const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
          resolve(status.status === 'end');
        } catch {
          resolve(false);
        }
      });
    });
    child.on('error', () => resolve(false));
  });
}

async function checkpoint({ patient, name, action, afterAction, verify }) {
  try {
    if (browserUnavailable()) throw new Error('浏览器页面已被关闭');
    await injectDemoFault(session.page, name);
    await action(session.page);
    const decision = afterAction ? await afterAction(session.page) : 'continue';
    if (decision === 'skip') return 'skip';
    await verify(session.page);
  } catch (firstError) {
    console.log(`[checkpoint] ${name} 失败：${firstError.message}`);
    if (browserUnavailable()) {
      await restoreBrowserSession(patient, name, firstError);
      try {
        const decision = afterAction ? await afterAction(session.page) : 'continue';
        if (decision === 'skip') return 'skip';
        await verify(session.page);
      } catch {
        await action(session.page);
        await verify(session.page);
      }
      return;
    }
    await showAiActivity(session.page, `AI 正在恢复 · ${patient.name}`);
    console.log('[recovery] 启动 UI-TARS 视觉恢复');
    const recovered = await runAiRecovery({ patient, checkpoint: name, error: firstError });
    console.log(`[recovery] UI-TARS 返回：${recovered ? 'END（恢复成功）' : '失败'}`);
    if (!recovered) throw new Error(`${name} 失败，AI 恢复失败：${firstError.message}`);
    try {
      const decision = afterAction ? await afterAction(session.page) : 'continue';
      if (decision === 'skip') return 'skip';
      await verify(session.page);
    } catch {
      await action(session.page);
      await verify(session.page);
    }
  }
}

async function captureRecord(page, patient, record, recordIndex) {
  await record.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const patientOutput = path.join(output, patient.patient_id);
  fs.mkdirSync(patientOutput, { recursive: true });
  const viewportHeight = page.viewportSize()?.height || 1000;
  const metrics = await record.evaluate((element) => ({
    top: element.getBoundingClientRect().top + window.scrollY,
    height: Math.max(element.scrollHeight, element.getBoundingClientRect().height),
  }));
  const prefix = `${patient.patient_id}-record-${String(recordIndex + 1).padStart(2, '0')}`;
  const files = [];

  if (metrics.height <= viewportHeight * 0.9) {
    const file = path.join(patientOutput, `${prefix}-page-01.png`);
    if (!fs.existsSync(file)) await record.screenshot({ path: file });
    files.push(file);
  } else {
    const step = Math.max(350, viewportHeight - 180);
    const maxOffset = Math.max(0, metrics.height - viewportHeight + 120);
    let offset = 0;
    let pageIndex = 1;
    while (true) {
      await page.evaluate(({ top, offset }) => window.scrollTo(0, top + offset), { top: metrics.top, offset });
      await page.waitForTimeout(300);
      const file = path.join(patientOutput, `${prefix}-page-${String(pageIndex).padStart(2, '0')}.png`);
      if (!fs.existsSync(file)) await page.screenshot({ path: file });
      files.push(file);
      if (offset >= maxOffset) break;
      offset = Math.min(offset + step, maxOffset);
      pageIndex += 1;
    }
  }
  return files;
}

function writeWorkflowReport(results) {
  const report = path.join(output, 'workflow-result.json');
  fs.writeFileSync(report, JSON.stringify(results, null, 2), 'utf8');
  return report;
}

function loadWorkflowReport() {
  if (!resumeEnabled) return [];
  const report = path.join(output, 'workflow-result.json');
  try {
    const value = JSON.parse(fs.readFileSync(report, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function main() {
  const results = loadWorkflowReport();
  const completedPatients = new Set(
    results
      .filter((row) => row.status === 'passed' || row.status === 'skipped')
      .map((row) => row.patient_id)
  );

  try {
    await startBrowserSession();

    for (const patient of roster) {
      if (completedPatients.has(patient.patient_id)) {
        console.log(`[resume] 已完成，跳过患者：${patient.patient_id}`);
        continue;
      }
      await preparePatientPage(patient);
      const details = () => session.page.locator('#details');
      let recordCount = 0;
      const screenshotFiles = new Set();

      const searchResult = await checkpoint({
        patient, name: '搜索患者',
        action: async (page) => {
          await page.locator('#search-input').fill(patient.patient_id);
          await page.getByRole('button', { name: '应用筛选' }).click();
        },
        afterAction: async (page) => {
          const card = page.locator('.result-card').filter({ hasText: patient.patient_id });
          return (await card.count()) === 0 ? 'skip' : 'continue';
        },
        verify: async (page) => {
          const card = page.locator('.result-card').filter({ hasText: patient.patient_id });
          await expect(card).toHaveCount(1);
          await expect(card).toContainText(patient.name);
          await expect(card).toContainText(patient.birth_date);
        },
      });
      if (searchResult === 'skip') {
        console.log(`[workflow] 名单患者不存在，跳过：${patient.patient_id} / ${patient.name}`);
        results.push({
          task_id: patient.task_id,
          patient_id: patient.patient_id,
          name: patient.name,
          birth_date: patient.birth_date,
          records: 0,
          screenshots: 0,
          screenshot_files: [],
          status: 'skipped',
          reason: '患者不存在于测试网站',
        });
        completedPatients.add(patient.patient_id);
        writeWorkflowReport(results);
        continue;
      }

      await checkpoint({
        patient, name: '进入病历',
        action: async (page) => {
          const card = page.locator('.result-card').filter({ hasText: patient.patient_id });
          await card.getByRole('button', { name: '进入病历' }).click();
        },
        verify: async (page) => {
          await expect(details()).toBeVisible();
          await expect(details().locator('h2')).toContainText(patient.patient_id);
          await expect(details()).toContainText(patient.name);
          await expect(details()).toContainText(patient.birth_date);
        },
      });

      await checkpoint({
        patient, name: '展开病历',
        action: async (page) => {
          const expand = page.getByRole('button', { name: '展开全部记录' });
          if (await expand.count()) await expand.click();
        },
        verify: async () => {
          const records = details().locator('.record-card');
          await expect(records.first()).toBeVisible();
          recordCount = await records.count();
          if (recordCount < 1) throw new Error('没有发现病历记录');
        },
      });

      await checkpoint({
        patient, name: '逐份截图',
        action: async (page) => {
          const records = details().locator('.record-card');
          recordCount = await records.count();
          for (let index = 0; index < recordCount; index += 1) {
            for (const file of await captureRecord(page, patient, records.nth(index), index)) {
              screenshotFiles.add(file);
            }
          }
        },
        verify: async () => {
          await expect(details()).toBeVisible();
          if (screenshotFiles.size < recordCount) throw new Error('病历截图数量不足');
        },
      });

      await checkpoint({
        patient, name: '返回列表',
        action: async (page) => {
          await page.getByRole('button', { name: '← 返回列表' }).first().click();
        },
        verify: async (page) => {
          await expect(page.locator('#search-input')).toBeVisible();
          await expect(details()).toBeHidden();
        },
      });

      results.push({
        task_id: patient.task_id,
        patient_id: patient.patient_id,
        name: patient.name,
        birth_date: patient.birth_date,
        records: recordCount,
        screenshots: screenshotFiles.size,
        screenshot_files: [...screenshotFiles].map((file) => path.relative(output, file)),
        browser_restarts: session.restarts,
        status: 'passed',
      });
      writeWorkflowReport(results);
      fs.writeFileSync(path.join(output, patient.patient_id, '.patient-done'), 'done\n', 'utf8');
      completedPatients.add(patient.patient_id);
      if (process.env.MEDICAL_TEST_PAUSE_AFTER_PATIENT === patient.patient_id) {
        console.log(`[test] 已写入患者报告，暂停等待外部终止：${patient.patient_id}`);
        await new Promise(() => {});
      }
    }
  } finally {
    await closeBrowserSession();
    const report = writeWorkflowReport(results);
    console.log(JSON.stringify({ patients: results.length, screenshots: results.reduce((sum, row) => sum + row.screenshots, 0), report }, null, 2));
  }
}

await main();
