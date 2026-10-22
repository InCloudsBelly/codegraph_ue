import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

describe.runIf(process.platform === 'win32')('UE fork local Windows installer', () => {
  let root: string;
  let log: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ue-local-install-'));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'fake-bin'));
    log = path.join(root, 'npm-calls.txt');
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@colbymchenry/codegraph', version: '1.6.2' }));
    fs.writeFileSync(path.join(root, 'fake-bin/npm.cmd'), [
      '@echo off',
      'echo %*>>"%UE_INSTALL_NPM_LOG%"',
      'if "%1"=="run" exit /b %UE_INSTALL_BUILD_EXIT%',
      'exit /b 0',
      '',
    ].join('\r\n'));
  });

  afterEach(() => {
    if (root) {
      expect(path.dirname(path.resolve(root))).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(root)).toMatch(/^codegraph-ue-local-install-/);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function run(args: string[] = [], buildExit = '0') {
    const script = path.join(root, 'scripts/local-install.bat');
    fs.copyFileSync(path.resolve('scripts/local-install.bat'), script);
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', script, ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        PATH: [path.join(root, 'fake-bin'), path.dirname(process.execPath), process.env.PATH].join(path.delimiter),
        UE_INSTALL_NPM_LOG: log,
        UE_INSTALL_BUILD_EXIT: buildExit,
      },
    });
  }

  it('builds before linking and returns to the caller', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(log, 'utf8').trim().split(/\r?\n/)).toEqual(['run build', 'link']);
  });

  it('does not link a failed build', () => {
    const result = run([], '7');
    expect(result.status).toBe(7);
    expect(fs.readFileSync(log, 'utf8').trim()).toBe('run build');
  });

  it('undo installs the declared official base version', () => {
    const result = run(['--undo']);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toContain('install -g "@colbymchenry/codegraph@1.6.2"');
  });
});
