import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`Missing argument: ${name}`);
  }
  return process.argv[index + 1];
}

function optionalArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : null;
}

function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, content, 'utf8');
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error?.code) || attempt === 9) break;
      // Windows screenshot/OCR watchers can briefly hold the status file.
      // A short retry avoids turning a transient sharing violation into a failed task.
      const delay = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(delay, 0, 0, 50 * (attempt + 1));
    }
  }
  try {
    fs.writeFileSync(file, content, 'utf8');
    fs.rmSync(temporary, { force: true });
  } catch (fallbackError) {
    fallbackError.cause = lastError;
    throw fallbackError;
  }
}

function writeStatus(value) {
  try {
    atomicWrite(statusFile, value);
  } catch (error) {
    // Status reporting must not abort the GUI task on Windows file-sharing races.
    console.warn(`[status] unable to write ${statusFile}: ${error.message}`);
  }
}

function isProcessRunning(processName) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${processName}`, '/NH'], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(false);
      resolve(String(stdout).toLowerCase().includes(processName.toLowerCase()));
    });
  });
}

async function relaunchTargetIfMissing() {
  const shortcut = process.env.UI_TARS_RECOVERY_SHORTCUT
    || (process.platform === 'win32'
      ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', '网易云音乐.lnk')
      : null);
  const processName = process.env.UI_TARS_RECOVERY_PROCESS || 'cloudmusic.exe';
  if (!shortcut || !fs.existsSync(shortcut)) {
    console.warn(`[recovery] 找不到网易云音乐快捷方式：${shortcut || '(未配置)'}`);
    return false;
  }
  if (await isProcessRunning(processName)) {
    console.log(`[recovery] 检测到 ${processName} 仍在运行，交给 UI-TARS 恢复窗口。`);
    return false;
  }
  console.warn(`[recovery] 未检测到 ${processName}，重新启动：${shortcut}`);
  try {
    const launcher = spawn('explorer.exe', [shortcut], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    launcher.once('error', (error) => {
      console.warn(`[recovery] 启动网易云音乐失败：${error.message}`);
    });
    launcher.unref();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    return true;
  } catch (error) {
    console.warn(`[recovery] 启动网易云音乐失败：${error.message}`);
    return false;
  }
}

function loadModelSettings(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.vlmBaseUrl || value.vlmApiKey || value.vlmModelName) {
    return {
      baseURL: value.vlmBaseUrl,
      apiKey: value.vlmApiKey,
      model: value.vlmModelName,
      useResponsesApi: value.useResponsesApi ?? false,
      maxLoopCount: value.maxLoopCount,
      loopIntervalInMs: value.loopIntervalInMs,
    };
  }
  return value;
}

const settingsFile = path.resolve(argument('--settings'));
const promptFile = path.resolve(argument('--prompt-file'));
const statusFile = path.resolve(argument('--status-file'));
const screenshotDirArg = optionalArgument('--screenshot-dir');
const screenshotDir = screenshotDirArg ? path.resolve(screenshotDirArg) : null;
const maxLoopCountArg = optionalArgument('--max-loop-count');
const loopIntervalArg = optionalArgument('--loop-interval-ms');
const recoveryAttempts = Math.max(Number(process.env.UI_TARS_RECOVERY_ATTEMPTS || 2), 0);
let screenshotIndex = 0;
let lastScreenshotHash = null;
let lastSavedStatus = null;
let activityProcess = null;
let activityStartedAt = 0;
const activityStopFile = screenshotDir ? path.join(screenshotDir, '.activity-stop') : null;
const activityReadyFile = screenshotDir ? path.join(screenshotDir, '.activity-ready') : null;
if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true });
const settings = loadModelSettings(settingsFile);
if (!settings.baseURL || !settings.apiKey || !settings.model) {
  throw new Error('VLM settings must include baseURL, apiKey, and model');
}

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const sdk = await import(pathToFileURL(path.join(projectRoot, 'UI-TARS-desktop-0.3.0/packages/ui-tars/sdk/dist/index.mjs')));
const operatorModule = await import(pathToFileURL(path.join(projectRoot, 'UI-TARS-desktop-0.3.0/packages/ui-tars/operators/nut-js/dist/index.mjs')));
const { GUIAgent } = sdk;
const { NutJSOperator } = operatorModule;

let lastStatus = { status: 'INIT' };
let activeAgent = null;
let repeatedActionKey = null;
let repeatedActionCount = 0;
function saveAgentScreenshot(data) {
  if (!screenshotDir) return null;
  const conversation = data?.conversations?.at?.(-1);
  const encoded = conversation?.screenshotBase64;
  if (!encoded) return null;
  const base64 = encoded.replace(/^data:image\/[^;]+;base64,/, '');
  const digest = crypto.createHash('sha256').update(base64).digest('hex');
  if (digest === lastScreenshotHash) return null;
  lastScreenshotHash = digest;
  const status = String(data?.status || '').toUpperCase();
  const shouldKeep = (
    screenshotIndex === 0
    || status !== lastSavedStatus
    || ['END', 'ERROR', 'CALL_USER'].includes(status)
  );
  if (!shouldKeep) return null;
  screenshotIndex += 1;
  const mime = conversation?.screenshotContext?.mime || 'image/png';
  const extension = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
  const file = path.join(screenshotDir, `agent-${String(screenshotIndex).padStart(3, '0')}.${extension}`);
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  lastSavedStatus = status;
  return file;
}

async function startActivityLight() {
  if (process.env.UI_TARS_ACTIVITY_LIGHT === '0' || !activityStopFile) return;
  const overlayScript = path.join(projectRoot, 'desktop_activity_overlay.py');
  if (!fs.existsSync(overlayScript)) return;
  fs.rmSync(activityStopFile, { force: true });
  fs.rmSync(activityReadyFile, { force: true });
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  try {
    activityProcess = spawn(
      python,
      [
        overlayScript,
        '--stop-file', activityStopFile,
        '--ready-file', activityReadyFile,
        '--label', process.env.UI_TARS_ACTIVITY_LABEL || 'AI 正在操作桌面',
      ],
      { cwd: projectRoot, detached: true, stdio: 'ignore', windowsHide: true },
    );
    activityProcess.once('error', (error) => {
      console.warn(`[activity-light] 蓝光进程启动失败：${error.message}`);
    });
    activityStartedAt = Date.now();
    activityProcess.unref();
    const deadline = Date.now() + 2000;
    while (!fs.existsSync(activityReadyFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!fs.existsSync(activityReadyFile)) {
      console.warn('[activity-light] 未检测到蓝光窗口就绪标记');
    }
  } catch (error) {
    console.warn(`[activity-light] 无法启动蓝光提示：${error.message}`);
  }
}

async function stopActivityLight() {
  const minimumVisibleMs = Math.max(Number(process.env.UI_TARS_ACTIVITY_MIN_MS || 5000), 0);
  const remainingMs = Math.max(0, minimumVisibleMs - (Date.now() - activityStartedAt));
  if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingMs));
  if (activityStopFile) fs.writeFileSync(activityStopFile, 'stop\n', 'utf8');
  if (activityReadyFile) fs.rmSync(activityReadyFile, { force: true });
  if (activityProcess && !activityProcess.killed) activityProcess.kill();
  activityProcess = null;
}
const onData = ({ data }) => {
  const prediction = data?.conversations?.at?.(-1)?.predictionParsed?.[0];
  if (prediction?.action_type) {
    const actionKey = JSON.stringify({
      action_type: prediction.action_type,
      action_inputs: prediction.action_inputs || {},
    });
    if (actionKey === repeatedActionKey) repeatedActionCount += 1;
    else {
      repeatedActionKey = actionKey;
      repeatedActionCount = 1;
    }
    if (repeatedActionCount >= 3 && activeAgent) {
      console.warn(`[guard] 连续 ${repeatedActionCount} 次生成相同动作，停止当前会话并进入恢复流程。`);
      activeAgent.stop();
    }
  }
  const screenshotFile = saveAgentScreenshot(data);
  lastStatus = {
    status: data.status,
    error: data.error?.message || data.error || null,
    screenshotFile,
    updatedAt: new Date().toISOString(),
  };
  writeStatus(lastStatus);
};

const operator = new NutJSOperator();
function createAgent() {
  const agent = new GUIAgent({
    model: {
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      useResponsesApi: settings.useResponsesApi ?? false,
    },
    operator,
    maxLoopCount: maxLoopCountArg ? Number(maxLoopCountArg) : settings.maxLoopCount,
    loopIntervalInMs: loopIntervalArg ? Number(loopIntervalArg) : settings.loopIntervalInMs,
    retry: {
      screenshot: { maxRetries: 3 },
      execute: { maxRetries: 1 },
    },
    onData,
    onError: ({ error }) => {
      lastStatus = {
        status: 'ERROR',
        error: error?.message || String(error),
        updatedAt: new Date().toISOString(),
      };
      writeStatus(lastStatus);
    },
  });
  activeAgent = agent;
  repeatedActionKey = null;
  repeatedActionCount = 0;
  return agent;
}

await startActivityLight();
const instruction = fs.readFileSync(promptFile, 'utf8');
try {
  await createAgent().run(instruction);
} catch (error) {
  lastStatus = {
    status: 'ERROR',
    error: error instanceof Error ? error.message : String(error),
    updatedAt: new Date().toISOString(),
  };
  writeStatus(lastStatus);
}

let finalStatus = String(lastStatus.status || '').toUpperCase();
for (let attempt = 1; attempt <= recoveryAttempts && !['END', 'CALL_USER'].includes(finalStatus); attempt += 1) {
  const recoveryInstruction = `${instruction}\n\n【自动恢复模式，第 ${attempt} 次】上一轮没有完成任务，目标软件可能被人工关闭或当前窗口已经切换到其他软件。请从当前屏幕重新确认并打开/切回网易云音乐，只操作网易云音乐；恢复成功后重新搜索“张杰”并播放歌曲。若连续尝试仍无法确认网易云音乐，必须输出 call_user()，不要操作其他软件，也不要输出 finished()。`;
  lastStatus = {
    status: 'RECOVERING',
    recoveryAttempt: attempt,
    error: lastStatus.error || '目标软件可能已关闭，开始桌面恢复',
    updatedAt: new Date().toISOString(),
  };
  writeStatus(lastStatus);
  console.warn(`[recovery] 第 ${attempt}/${recoveryAttempts} 次恢复：重新寻找网易云音乐…`);
  await relaunchTargetIfMissing();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  try {
    await createAgent().run(recoveryInstruction);
  } catch (error) {
    lastStatus = {
      status: 'ERROR',
      error: error instanceof Error ? error.message : String(error),
      recoveryAttempt: attempt,
      updatedAt: new Date().toISOString(),
    };
    writeStatus(lastStatus);
  }
  finalStatus = String(lastStatus.status || '').toUpperCase();
}

writeStatus(lastStatus);
await stopActivityLight();
finalStatus = String(lastStatus.status || '').toUpperCase();
if (finalStatus === 'END') process.exitCode = 0;
else if (finalStatus === 'CALL_USER') process.exitCode = 3;
else process.exitCode = 4;
