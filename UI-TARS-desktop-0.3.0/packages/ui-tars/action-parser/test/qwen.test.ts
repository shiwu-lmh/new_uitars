import { describe, expect, it } from 'vitest';
import { UITarsModelVersion } from '@ui-tars/shared/types';

import { actionParser } from '../src/actionParser';

const parseQwen = (prediction: string) =>
  actionParser({
    prediction,
    factor: [1000, 1000],
    screenContext: { width: 1920, height: 1080 },
    scaleFactor: 1,
    modelVer: UITarsModelVersion.QWEN_3_8_FLASH,
  }).parsed;

describe('Qwen GUI actions', () => {
  it('converts normalized coordinates into the correct screen position', () => {
    const [action] = parseQwen(
      "Thought: Open the button.\nAction: click(start_box='[500,500,500,500]')",
    );

    expect(action.action_type).toBe('click');
    expect(action.action_inputs.start_box).toBe('[0.5,0.5,0.5,0.5]');
    expect(action.action_inputs.start_coords).toEqual([960, 540]);
  });

  it('rejects pixel coordinates before they can become an incorrect click', () => {
    expect(() =>
      parseQwen(
        "Thought: Click.\nAction: click(start_box='[1200,600,1200,600]')",
      ),
    ).toThrow(/coordinate/i);
  });

  it('rejects unknown or malformed actions', () => {
    expect(() => parseQwen('I would click the button.')).toThrow(/action/i);
    expect(() =>
      parseQwen("Thought: Click.\nAction: click(start_box='[x,500]')"),
    ).toThrow(/coordinate/i);
  });

  it('executes at most one model action per screenshot', () => {
    expect(() =>
      parseQwen('Thought: Two actions.\nAction: wait()\n\nwait()'),
    ).toThrow(/one action/i);
    expect(() =>
      parseQwen(
        "Thought: Two actions.\nAction: wait()\nAction: click(start_box='[500,500,500,500]')",
      ),
    ).toThrow(/one action/i);
  });
});
