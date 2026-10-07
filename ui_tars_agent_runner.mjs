import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
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
let screenshotIndex = 0;
let lastScreenshotHash = null;
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
function saveAgentScreenshot(data) {
  if (!screenshotDir) return null;
  const conversation = data?.conversations?.at?.(-1);
  const encoded = conversation?.screenshotBase64;
  if (!encoded) return null;
  const base64 = encoded.replace(/^data:image\/[^;]+;base64,/, '');
  const digest = crypto.createHash('sha256').update(base64).digest('hex');
  if (digest === lastScreenshotHash) return null;
  lastScreenshotHash = digest;
  screenshotIndex += 1;
  const mime = conversation?.screenshotContext?.mime || 'image/png';
  const extension = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png';
  const file = path.join(screenshotDir, `agent-${String(screenshotIndex).padStart(3, '0')}.${extension}`);
  fs.writeFileSync(file, Buffer.from(base64, 'base64'));
  return file;
}
const onData = ({ data }) => {
  const screenshotFile = saveAgentScreenshot(data);
  lastStatus = {
    status: data.status,
    error: data.error?.message || data.error || null,
    screenshotFile,
    updatedAt: new Date().toISOString(),
  };
  writeStatus(lastStatus);
};

const agent = new GUIAgent({
  model: {
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    useResponsesApi: settings.useResponsesApi ?? false,
  },
  operator: new NutJSOperator(),
  maxLoopCount: maxLoopCountArg ? Number(maxLoopCountArg) : settings.maxLoopCount,
  loopIntervalInMs: loopIntervalArg ? Number(loopIntervalArg) : settings.loopIntervalInMs,
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

try {
  await agent.run(fs.readFileSync(promptFile, 'utf8'));
} catch (error) {
  lastStatus = {
    status: 'ERROR',
    error: error instanceof Error ? error.message : String(error),
    updatedAt: new Date().toISOString(),
  };
  writeStatus(lastStatus);
}

writeStatus(lastStatus);
const finalStatus = String(lastStatus.status || '').toUpperCase();
if (finalStatus === 'END') process.exitCode = 0;
else if (finalStatus === 'CALL_USER') process.exitCode = 3;
else process.exitCode = 4;
