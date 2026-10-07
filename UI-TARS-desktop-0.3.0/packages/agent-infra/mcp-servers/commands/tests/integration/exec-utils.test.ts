/**
 * The following code is modified based on
 * https://github.com/g0t4/mcp-server-commands/blob/master/tests/integration/exec-utils.test.ts
 *
 * MIT License
 * Copyright (c) 2025 g0t4
 * https://github.com/g0t4/mcp-server-commands/blob/master/LICENSE
 */
import os from 'os';
import { execFileWithInput } from '../../src/exec-utils.js';
import { describe, test, expect } from 'vitest';

// FYI Claude generated most of these, by dog fooding the run_command/script tools!
// I am going to keep asking Claude to add new tests to see how I feel about that workflow

describe('execFileWithInput integration tests', () => {
  // ok, impressive choice of "seam" to add testing of the most critical part, executing the command! this is EXACTLY what I had in mind and didn't even tell Claude I wanted.

  test('should execute a simple portable command', async () => {
    const result = await execFileWithInput('node', 'console.log("Hello World")', {});
    expect(result.stdout.trim()).toBe('Hello World');
    expect(result.stderr).toBe('');
  });

  test('should handle command errors properly', async () => {
    try {
      await execFileWithInput('node', 'nonexistentcommand()', {});
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      expect(error.stderr).toContain('nonexistentcommand');
      expect(error.message).toBeTruthy();
    }
  });

  test.skip('should handle fish shell command', async () => {
    const result = await execFileWithInput(
      'fish',
      'echo "Hello from Fish"',
      {},
    );
    expect(result.stdout.trim()).toBe('Hello from Fish');
    expect(result.stderr).toBe('');
  });

  // TODO make sure to cover the fish workaround logic, in all its edge cases and then can leave those tests when I remove that or just nuke them
  test.skip('should handle command errors properly in fish', async () => {
    try {
      await execFileWithInput('fish', 'totallynonexistentcommand', {});
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      expect(error.stderr).toContain('totallynonexistentcommand');
      expect(error.message).toBeTruthy();
    }
  });

  test.skip('should execute zsh command', async () => {
    const result = await execFileWithInput('zsh', 'echo "Hello from Zsh"', {});
    expect(result.stdout.trim()).toBe('Hello from Zsh');
    expect(result.stderr).toBe('');
  });

  test.skip('should handle command errors properly in zsh', async () => {
    try {
      await execFileWithInput('zsh', 'completelynonexistentcommand', {});
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      expect(error.stderr).toContain('completelynonexistentcommand');
      expect(error.message).toBeTruthy();
    }
  });

  test.skip('should handle multiline scripts in zsh', async () => {
    const script = `
      echo "Line 1 from Zsh"
      for i in 1 2 3; do
        echo "Number $i"
      done
    `;
    const result = await execFileWithInput('zsh', script, {});
    //expect(lines[0]).toContain('Line 1 from Zsh');
    //expect(lines[1]).toContain('Number 1');
    //expect(lines[2]).toContain('Number 2');
    //expect(lines[3]).toContain('Number 3');
    expect(result.stdout).toContain(`Line 1 from Zsh
Number 1
Number 2
Number 3
`);
  });

  test('should respect working directory option', async () => {
    const cwd = process.cwd();
    const result = await execFileWithInput('node', 'process.stdout.write(process.cwd())', { cwd });
    expect(result.stdout.trim()).toBe(cwd);
  });

  test('should handle multiline scripts', async () => {
    const script = `
      console.log("Line 1")
      console.log("Line 2")
      console.log("Line 3")
    `;
    const result = await execFileWithInput('node', script, {});
    // validate all of output:
    expect(result.stdout).toContain(`Line 1
Line 2
Line 3`);
  });
});

// TODO add testing of try/catch in runScript block
//   just make sure I cover failure cases through the catch blocks
//   maybe, push the try/catch into a new, interim seam
//   keep this testing separate of the lower level seam around execWithInput
//   don't need a ton of tests, just an integration "glue" test of the try/catch impl (so if it changes I can validate it)
//

// TODO add tests for logging on failures?
