/**
 * Copyright (c) 2025 Bytedance, Inc. and its affiliates.
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { useState, useMemo, useEffect } from 'react';
import {
  Camera,
  Copy,
  Download,
  MousePointerClick,
  SkipBack,
  SkipForward,
} from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { Slider } from '@renderer/components/ui/slider';
import { type ConversationWithSoM } from '@main/shared/types';
import { ActionIconMap } from '@renderer/const/actions';
import ms from 'ms';
import { api } from '@renderer/api';
import { toast } from 'sonner';

import { SnapshotImage } from './image';

interface ImageGalleryProps {
  selectImgIndex?: number;
  messages: ConversationWithSoM[];
}

interface Action {
  type: string;
  action: string;
  cost?: number;
  input?: string;
}

const normalizeOcrLine = (line: string) =>
  line
    .toLocaleLowerCase()
    .replace(/[\s，,。.!！?？:：;；"“”‘’（）()【】\[\]<>《》、]/g, '');

const mergeOcrPages = (pages: string[]) => {
  const mergedLines: string[] = [];
  const seenLines = new Set<string>();

  pages.forEach((page) => {
    const lines = page
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const maxOverlap = Math.min(mergedLines.length, lines.length, 30);
    let overlap = 0;

    for (let size = maxOverlap; size > 0; size -= 1) {
      const previous = mergedLines.slice(-size).map(normalizeOcrLine);
      const next = lines.slice(0, size).map(normalizeOcrLine);
      if (previous.every((line, index) => line === next[index])) {
        overlap = size;
        break;
      }
    }

    lines.slice(overlap).forEach((line) => {
      const normalized = normalizeOcrLine(line);
      if (normalized && seenLines.has(normalized)) return;
      if (normalized) seenLines.add(normalized);
      mergedLines.push(line);
    });
  });

  return mergedLines.join('\n');
};

const ImageGallery: React.FC<ImageGalleryProps> = ({
  messages,
  selectImgIndex,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrText, setOcrText] = useState('');
  const [batchText, setBatchText] = useState('');
  const [ocrProgress, setOcrProgress] = useState({ completed: 0, total: 0 });

  const imageEntries = useMemo(() => {
    return messages
      .map((msg, index) => {
        let actions: Action[] = [];

        if (msg.from === 'human') {
          actions = [
            {
              action: 'Screenshot',
              type: 'screenshot',
              cost: msg.timing?.cost,
            },
          ];
        } else {
          actions =
            msg.predictionParsed?.map((item) => {
              let input = '';

              if (item.action_inputs?.start_box) {
                input += `(start_box: ${item.action_inputs.start_box})`;
              }
              if (item.action_inputs?.content) {
                input += ` (${item.action_inputs.content})`;
              }
              if (item.action_inputs?.key) {
                input += ` (${item.action_inputs.key})`;
              }

              return {
                action: 'Action',
                type: item.action_type,
                cost: msg.timing?.cost,
                input,
              };
            }) || [];
        }
        return {
          originalIndex: index,
          message: msg,
          imageData:
            msg.screenshotBase64 || msg.screenshotBase64WithElementMarker,
          actions: actions,
          timing: msg.timing,
        };
      })
      .filter(
        (entry): entry is typeof entry & { imageData: string } =>
          Boolean(entry.imageData),
      );
  }, [messages]);

  useEffect(() => {
    if (typeof selectImgIndex === 'number') {
      const targetIndex = imageEntries.findIndex(
        (entry) => entry.originalIndex === selectImgIndex,
      );
      if (targetIndex !== -1) {
        setCurrentIndex(targetIndex);
      }
    }
    // console.log('selectImgIndex', selectImgIndex);
  }, [selectImgIndex, imageEntries]);

  useEffect(() => {
    setCurrentIndex(imageEntries.length - 1);
  }, [imageEntries]);

  const handleSliderChange = (value: number[]) => {
    setCurrentIndex(value[0]);
  };

  const handlePrevious = () => {
    setCurrentIndex(
      (current) => (current - 1 + imageEntries.length) % imageEntries.length,
    );
  };

  const handleNext = () => {
    setCurrentIndex((current) => (current + 1) % imageEntries.length);
  };

  const currentEntry = imageEntries[currentIndex];
  const mime = currentEntry?.message?.screenshotContext?.mime || 'image/png';

  useEffect(() => {
    setOcrText('');
  }, [currentEntry?.imageData]);

  if (imageEntries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No images to display
      </div>
    );
  }

  if (!currentEntry) {
    return null;
  }

  const handleRecognize = async () => {
    setOcrLoading(true);
    setOcrText('');
    try {
      const result = await api.recognizeScreenshot({
        imageBase64: currentEntry.imageData,
        mime,
      });
      setOcrText(result || '未识别到文字');
    } catch (error) {
      toast.error('OCR 识别失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setOcrLoading(false);
    }
  };

  const handleRecognizeAll = async () => {
    const uniqueEntries = Array.from(
      new Map(imageEntries.map((entry) => [entry.imageData, entry])).values(),
    );
    const pageTexts: string[] = [];
    let failedCount = 0;

    setOcrLoading(true);
    setBatchText('');
    setOcrProgress({ completed: 0, total: uniqueEntries.length });

    for (const [index, entry] of uniqueEntries.entries()) {
      try {
        const text = await api.recognizeScreenshot({
          imageBase64: entry.imageData,
          mime: entry.message?.screenshotContext?.mime || 'image/png',
        });
        if (text.trim()) pageTexts.push(text);
      } catch (error) {
        failedCount += 1;
        console.warn(`Screenshot OCR failed at image ${index + 1}:`, error);
      } finally {
        setOcrProgress({ completed: index + 1, total: uniqueEntries.length });
      }
    }

    const mergedText = mergeOcrPages(pageTexts);
    setBatchText(mergedText || (failedCount ? '' : '未识别到文字'));
    setOcrLoading(false);

    if (failedCount) {
      toast.error(
        failedCount === uniqueEntries.length ? '截图识别失败' : '部分截图识别失败',
        {
          description: `成功处理 ${uniqueEntries.length - failedCount}/${uniqueEntries.length} 张截图。`,
        },
      );
    } else {
      toast.success(`已整理 ${uniqueEntries.length} 张截图`);
    }
  };

  const handleCopyBatchText = async () => {
    try {
      await navigator.clipboard.writeText(batchText);
      toast.success('汇总文档已复制');
    } catch (error) {
      toast.error('复制失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(ocrText);
      toast.success('识别结果已复制');
    } catch (error) {
      toast.error('复制失败', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleDownloadDocument = () => {
    const markdown = `# 截图 OCR 汇总\n\n截图数量：${ocrProgress.total}\n\n${batchText}\n`;
    const url = URL.createObjectURL(
      new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `截图 OCR 汇总-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const renderActions = () => {
    return (
      <>
        {currentEntry.actions.map((action, idx) => {
          const ActionIcon = ActionIconMap[action.type] || MousePointerClick;

          if (!action.type) {
            return null;
          }

          return (
            <div
              key={idx}
              className="flex items-start gap-2 min-w-fit flex-shrink-0"
            >
              <div className="text-muted-foreground">
                <ActionIcon className="w-9 h-9" />
              </div>
              <div className="flex-1">
                <div className="text-base font-medium leading-tight">
                  {action.action}
                </div>
                <div className="text-xs text-muted-foreground max-w-full mr-4">
                  <span className="font-medium text-primary/70">
                    {action.type}
                  </span>
                  {action.input && (
                    <span className="text-primary/70 break-all max-w-full">
                      {action.input}
                    </span>
                  )}
                  {action.cost && (
                    <span className="ml-1 text-muted-foreground/70">
                      {ms(action.cost)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </>
    );
  };

  const renderSlider = () => {
    return (
      <>
        <Button
          variant="ghost"
          size="icon"
          onClick={handlePrevious}
          disabled={imageEntries.length <= 1 || currentIndex === 0}
        >
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleNext}
          disabled={
            imageEntries.length <= 1 || currentIndex === imageEntries.length - 1
          }
        >
          <SkipForward className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <Slider
            value={[currentIndex]}
            min={0}
            max={imageEntries.length - 1}
            step={1}
            onValueChange={handleSliderChange}
            disabled={imageEntries.length <= 1}
          />
        </div>
      </>
    );
  };

  return (
    <div className="h-full flex flex-col py-4">
      <div className="flex overflow-x-scroll gap-2">{renderActions()}</div>

      <SnapshotImage
        src={`data:${mime};base64,${currentEntry.imageData}`}
        alt={`screenshot from message ${currentEntry.originalIndex + 1}`}
      />

      <div className="flex items-center gap-2 mt-4">
        {renderSlider()}
        <Button
          variant="outline"
          size="sm"
          onClick={handleRecognize}
          disabled={ocrLoading}
          className="shrink-0"
        >
          <Camera className="mr-2 h-4 w-4" />
          {ocrLoading ? '识别中…' : '识别文字'}
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={handleRecognizeAll}
          disabled={ocrLoading || imageEntries.length === 0}
          className="shrink-0"
        >
          {ocrLoading
            ? `整理中 ${ocrProgress.completed}/${ocrProgress.total}`
            : `整理全部截图（${imageEntries.length}）`}
        </Button>
      </div>
      {ocrText && (
        <div className="mt-3 max-h-40 overflow-auto rounded-md border bg-muted/40 p-3">
          <div className="mb-2 flex items-center justify-between text-sm font-medium">
            OCR 结果
            <Button variant="ghost" size="sm" onClick={handleCopyText}>
              <Copy className="mr-2 h-4 w-4" />复制
            </Button>
          </div>
          <pre className="whitespace-pre-wrap break-words text-sm font-sans">{ocrText}</pre>
        </div>
      )}
      {batchText && (
        <div className="mt-3 max-h-[35vh] overflow-auto rounded-md border bg-muted/40 p-3">
          <div className="mb-2 flex items-center justify-between text-sm font-medium">
            汇总文档（已去重）
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleCopyBatchText}
              >
                <Copy className="mr-2 h-4 w-4" />复制
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDownloadDocument}>
                <Download className="mr-2 h-4 w-4" />下载 Markdown
              </Button>
            </div>
          </div>
          <pre className="whitespace-pre-wrap break-words text-sm font-sans">{batchText}</pre>
        </div>
      )}
    </div>
  );
};

export default ImageGallery;
