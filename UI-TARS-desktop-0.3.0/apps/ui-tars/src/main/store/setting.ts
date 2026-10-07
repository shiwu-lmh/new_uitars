/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import ElectronStore from 'electron-store';
import yaml from 'js-yaml';

import * as env from '@main/env';
import { logger } from '@main/logger';

import {
  LocalStore,
  SearchEngineForSettings,
  VLMProviderV2,
  Operator,
  QWEN_3_8_FLASH_BASE_URL,
  QWEN_3_8_FLASH_MODEL_NAME,
} from './types';
import { validatePreset } from './validate';
import { BrowserWindow } from 'electron';

export const DEFAULT_SETTING: LocalStore = {
  language: 'en',
  vlmProvider:
    (env.vlmProvider as VLMProviderV2) || VLMProviderV2.qwen_3_8_flash,
  vlmBaseUrl: env.vlmBaseUrl || QWEN_3_8_FLASH_BASE_URL,
  vlmApiKey: env.vlmApiKey || '',
  vlmModelName: env.vlmModelName || QWEN_3_8_FLASH_MODEL_NAME,
  useResponsesApi: false,
  ocrBaseUrl: env.ocrBaseUrl || 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs',
  ocrApiKey: env.ocrApiKey || '',
  ocrModelName: env.ocrModelName,
  maxLoopCount: 100,
  loopIntervalInMs: 1000,
  searchEngineForBrowser: SearchEngineForSettings.GOOGLE,
  operator: Operator.LocalComputer,
  reportStorageBaseUrl: '',
  utioBaseUrl: '',
};

export class SettingStore {
  private static instance: ElectronStore<LocalStore>;

  public static getInstance(): ElectronStore<LocalStore> {
    if (!SettingStore.instance) {
      SettingStore.instance = new ElectronStore<LocalStore>({
        name: 'ui_tars.setting',
        defaults: DEFAULT_SETTING,
      });

      const saved = SettingStore.instance.store;
      const isLegacyDemoOcr =
        saved.ocrModelName === 'demo-ocr' ||
        saved.ocrBaseUrl?.includes('127.0.0.1:8787');
      if (isLegacyDemoOcr) {
        SettingStore.instance.set({
          ...saved,
          ocrBaseUrl:
            env.ocrBaseUrl ||
            'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs',
          ocrApiKey: saved.ocrApiKey || env.ocrApiKey || '',
          ocrModelName: env.ocrModelName,
        });
      }
      if (!saved.vlmProvider && !saved.vlmBaseUrl && !saved.vlmModelName) {
        SettingStore.instance.set({
          ...saved,
          vlmProvider: VLMProviderV2.qwen_3_8_flash,
          vlmBaseUrl: QWEN_3_8_FLASH_BASE_URL,
          vlmModelName: QWEN_3_8_FLASH_MODEL_NAME,
          useResponsesApi: false,
        });
      }

      SettingStore.instance.onDidAnyChange((newValue) => {
        logger.log('SettingStore updated');
        // Notify that value updated
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('setting-updated', newValue);
        });
      });
    }
    return SettingStore.instance;
  }

  public static set<K extends keyof LocalStore>(
    key: K,
    value: LocalStore[K],
  ): void {
    SettingStore.getInstance().set(key, value);
  }

  public static setStore(state: LocalStore): void {
    SettingStore.getInstance().set(state);
  }

  public static get<K extends keyof LocalStore>(key: K): LocalStore[K] {
    return SettingStore.getInstance().get(key);
  }

  public static remove<K extends keyof LocalStore>(key: K): void {
    SettingStore.getInstance().delete(key);
  }

  public static getStore(): LocalStore {
    return SettingStore.getInstance().store;
  }

  public static clear(): void {
    SettingStore.getInstance().set(DEFAULT_SETTING);
  }

  public static openInEditor(): void {
    SettingStore.getInstance().openInEditor();
  }

  public static async importPresetFromUrl(
    url: string,
    autoUpdate = false,
  ): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch preset: ${response.status}`);
      }

      const yamlText = await response.text();
      const preset = yaml.load(yamlText);
      const validatedPreset = validatePreset(preset);

      SettingStore.setStore({
        ...validatedPreset,
        presetSource: {
          type: 'remote',
          url,
          autoUpdate,
          lastUpdated: Date.now(),
        },
      });
    } catch (error) {
      logger.error(error);
      throw new Error(
        `Failed to import preset: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  public static async importPresetFromText(
    yamlContent: string,
  ): Promise<LocalStore> {
    try {
      const settings = await parsePresetYaml(yamlContent);
      return settings;
    } catch (error) {
      logger.error('Failed to import preset from text:', error);
      throw error;
    }
  }

  public static async fetchPresetFromUrl(url: string): Promise<LocalStore> {
    try {
      const response = await fetch(url);
      const yamlContent = await response.text();
      return await this.importPresetFromText(yamlContent);
    } catch (error) {
      logger.error('Failed to fetch preset from URL:', error);
      throw error;
    }
  }
}

async function parsePresetYaml(yamlContent: string): Promise<LocalStore> {
  const preset = yaml.load(yamlContent);
  const validatedPreset = validatePreset(preset);
  return validatedPreset;
}
