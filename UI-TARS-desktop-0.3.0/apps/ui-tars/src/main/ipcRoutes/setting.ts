/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import { initIpc } from '@ui-tars/electron-ipc/main';
import { OpenAI } from 'openai';
import { logger } from '../logger';
import { SettingStore } from '@main/store/setting';

const t = initIpc.create();

const DEFAULT_PADDLEOCR_JOBS_URL =
  'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs';

const normalizeJobsUrl = (baseUrl: string) => {
  const url = baseUrl.trim().replace(/\/+$/, '');
  if (!url) return DEFAULT_PADDLEOCR_JOBS_URL;
  return url
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/ocr$/i, '/jobs');
};

const extractMarkdownText = (payload: unknown): string[] => {
  const texts: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const markdown = record.markdown;
    if (markdown && typeof markdown === 'object') {
      const text = (markdown as Record<string, unknown>).text;
      if (typeof text === 'string' && text.trim()) texts.push(text);
    }
    for (const key of ['result', 'data', 'extractResult', 'layoutParsingResults']) {
      if (record[key] !== undefined) visit(record[key]);
    }
  };
  visit(payload);
  return texts;
};

const readJson = async (response: Response) => {
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`PaddleOCR 返回了无效 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' ? JSON.stringify(payload) : text;
    throw new Error(`PaddleOCR 请求失败（HTTP ${response.status}）：${detail.slice(0, 500)}`);
  }
  return payload as Record<string, unknown>;
};

const recognizeWithPaddleOcr = async ({
  imageBase64,
  mime,
  jobsUrl,
  apiKey,
  model,
}: {
  imageBase64: string;
  mime: string;
  jobsUrl: string;
  apiKey: string;
  model: string;
}) => {
  const form = new FormData();
  form.append('model', model);
  form.append(
    'optionalPayload',
    JSON.stringify({
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      useLayoutDetection: false,
      useChartRecognition: false,
    }),
  );
  form.append(
    'file',
    new Blob([Buffer.from(imageBase64, 'base64')], { type: mime }),
    `screenshot.${mime.split('/')[1] || 'png'}`,
  );

  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  const submitted = await readJson(
    await fetch(jobsUrl, { method: 'POST', headers, body: form }),
  );
  const jobId = (submitted.data as Record<string, unknown> | undefined)?.jobId;
  if (typeof jobId !== 'string' || !jobId) {
    throw new Error('PaddleOCR 未返回 jobId');
  }

  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const status = await readJson(
      await fetch(`${jobsUrl}/${encodeURIComponent(jobId)}`, { headers }),
    );
    const data = (status.data || {}) as Record<string, unknown>;
    const extractResult = (data.extractResult || {}) as Record<string, unknown>;
    const state = data.state || extractResult.state;
    if (state === 'failed') {
      throw new Error(String(data.errorMsg || extractResult.errorMsg || 'PaddleOCR 解析失败'));
    }
    if (state !== 'done') continue;

    const resultUrls = (data.resultUrl || extractResult.resultUrl || {}) as Record<
      string,
      unknown
    >;
    const jsonUrl = resultUrls.jsonUrl;
    const markdownUrl = resultUrls.markdownUrl;
    if (typeof jsonUrl === 'string') {
      const result = await readJson(await fetch(jsonUrl));
      const texts = extractMarkdownText(result);
      if (texts.length) return texts.join('\n\n');
    }
    if (typeof markdownUrl === 'string') {
      const response = await fetch(markdownUrl);
      if (!response.ok) throw new Error(`PaddleOCR 结果下载失败（HTTP ${response.status}）`);
      return await response.text();
    }
    throw new Error('PaddleOCR 已完成，但没有返回识别结果地址');
  }
  throw new Error('PaddleOCR 等待超时（4 分钟）');
};

export const settingRoute = t.router({
  recognizeScreenshot: t.procedure
    .input<{
      imageBase64: string;
      mime: string;
    }>()
    .handle(async ({ input }) => {
      const { ocrBaseUrl, ocrApiKey, ocrModelName } = SettingStore.getStore();
      if (!ocrModelName?.trim()) {
        throw new Error('请先在设置中填写 PaddleOCR-VL 模型名称');
      }
      if (!input.imageBase64 || !/^image\/[\w.+-]+$/.test(input.mime)) {
        throw new Error('截图数据无效');
      }

      return recognizeWithPaddleOcr({
        imageBase64: input.imageBase64,
        mime: input.mime,
        jobsUrl: normalizeJobsUrl(ocrBaseUrl || DEFAULT_PADDLEOCR_JOBS_URL),
        apiKey: ocrApiKey?.trim() || '',
        model: ocrModelName.trim(),
      });
    }),
  checkVLMResponseApiSupport: t.procedure
    .input<{
      baseUrl: string;
      apiKey: string;
      modelName: string;
    }>()
    .handle(async ({ input }) => {
      try {
        const openai = new OpenAI({
          apiKey: input.apiKey,
          baseURL: input.baseUrl,
        });
        const result = await openai.responses.create({
          model: input.modelName,
          input: 'return 1+1=?',
          stream: false,
        });
        return Boolean(result?.id || result?.previous_response_id);
      } catch (e) {
        logger.warn('[checkVLMResponseApiSupport] failed:', e);
        return false;
      }
    }),
  checkModelAvailability: t.procedure
    .input<{
      baseUrl: string;
      apiKey: string;
      modelName: string;
    }>()
    .handle(async ({ input }) => {
      const openai = new OpenAI({
        apiKey: input.apiKey,
        baseURL: input.baseUrl,
      });
      const completion = await openai.chat.completions.create({
        model: input.modelName,
        messages: [{ role: 'user', content: 'return 1+1=?' }],
        stream: false,
      });

      return Boolean(completion?.id || completion.choices[0].message.content);
    }),
});
