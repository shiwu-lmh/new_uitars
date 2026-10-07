import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { Button } from '@renderer/components/ui/button';
import { LocalStore } from '@main/store/validate';

import { VLMSettings, VLMSettingsRef } from './category/vlm';
import { useRef } from 'react';

interface LocalSettingsDialogProps {
  isOpen: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

export const checkVLMSettings = async () => {
  try {
    const settingRpc = window.electron.setting;
    const currentSetting = await Promise.race([
      settingRpc.getSetting(),
      new Promise<null>((_, reject) => {
        setTimeout(() => reject(new Error('读取 VLM 设置超时')), 3000);
      }),
    ]);
    const { vlmApiKey, vlmBaseUrl, vlmModelName, vlmProvider } =
      (currentSetting || {}) as Partial<LocalStore>;

    return Boolean(vlmApiKey && vlmBaseUrl && vlmModelName && vlmProvider);
  } catch (error) {
    console.error('Failed to read VLM settings:', error);
    return false;
  }
};

export const LocalSettingsDialog = ({
  isOpen,
  onSubmit,
  onClose,
}: LocalSettingsDialogProps) => {
  const vlmSettingsRef = useRef<VLMSettingsRef>(null);

  const handleGetStart = async () => {
    try {
      await vlmSettingsRef.current?.submit();
      onSubmit();
    } catch (error) {
      console.error('Failed to submit settings:', error);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[480]">
        <DialogHeader>
          <DialogTitle>VLM Settings</DialogTitle>
          <DialogDescription>
            Enter VLM settings to enable the model to control the local computer
            or browser.
          </DialogDescription>
        </DialogHeader>
        <VLMSettings ref={vlmSettingsRef} />
        <Button className="mt-8 mx-8" onClick={handleGetStart}>
          Get Start
        </Button>
      </DialogContent>
    </Dialog>
  );
};
