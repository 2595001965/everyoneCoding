import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockShell, runShellContract, type ContractHarness } from '../index';

/**
 * 用 MockShell 跑同一份契约用例。
 * Tauri / Electron 实现在各自 app 中注入同一套 harness 复用本套件。
 */
function createContractShell(): MockShell {
  const shell = new MockShell({ dataDir: 'C:/tmp/ec-contract' });
  shell.process.registerHandler('echo', (args, controller) => {
    controller.pushStdout(args.join(' '));
    controller.exit(0);
  });
  return shell;
}

const harness = { describe, it, expect, beforeEach, afterEach } as unknown as ContractHarness;

runShellContract('MockShell', () => createContractShell(), harness);
