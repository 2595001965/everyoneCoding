import { describe, expect, it } from 'vitest';
import { LogStream } from '../backend/log-stream';

describe('日志分级 classify', () => {
  const ls = new LogStream();
  it('stderr 一律 error', () => {
    expect(ls.classify('normal', 'stderr')).toBe('error');
  });
  it('错误关键字 → error', () => {
    expect(ls.classify('fatal exception', 'stdout')).toBe('error');
  });
  it('警告关键字 → warn', () => {
    expect(ls.classify('deprecated api', 'stdout')).toBe('warn');
  });
  it('普通 → info', () => {
    expect(ls.classify('server started', 'stdout')).toBe('info');
  });
});

describe('日志过滤与订阅', () => {
  it('按级别/关键字/来源过滤', () => {
    const ls = new LogStream({ clock: () => 1000 });
    ls.push({ source: 'install', text: 'npm install done', stream: 'stdout' });
    ls.push({ source: 'run', text: 'listening on 8080', stream: 'stdout' });
    ls.push({ source: 'run', text: 'warn: high memory', stream: 'stdout' });
    expect(ls.lines()).toHaveLength(3);
    expect(ls.lines({ level: 'warn' })).toHaveLength(1);
    expect(ls.lines({ source: 'run' })).toHaveLength(2);
    expect(ls.lines({ keyword: 'listening' })).toHaveLength(1);
    expect(ls.lines({ source: 'run', level: 'warn' })).toHaveLength(1);
  });

  it('上限裁剪保留最近 N 条', () => {
    const ls = new LogStream({ max: 2, clock: () => 1000 });
    ls.push({ source: 'task', text: 'a', stream: 'stdout' });
    ls.push({ source: 'task', text: 'b', stream: 'stdout' });
    ls.push({ source: 'task', text: 'c', stream: 'stdout' });
    expect(ls.lines()).toHaveLength(2);
    expect(ls.lines()[1]!.text).toBe('c');
  });

  it('订阅在 push 时收到通知', () => {
    const ls = new LogStream({ clock: () => 1000 });
    const received: string[] = [];
    const unsub = ls.subscribe((l) => received.push(l.text));
    ls.push({ source: 'task', text: 'hello', stream: 'stdout' });
    expect(received).toEqual(['hello']);
    unsub();
    ls.push({ source: 'task', text: 'world', stream: 'stdout' });
    expect(received).toEqual(['hello']);
  });

  it('clear 清空日志', () => {
    const ls = new LogStream({ clock: () => 1000 });
    ls.push({ source: 'task', text: 'x', stream: 'stdout' });
    ls.clear();
    expect(ls.lines()).toHaveLength(0);
  });
});

describe('日志脱敏', () => {
  it('密钥明文不出现在日志中', () => {
    const ls = new LogStream({ clock: () => 1000 });
    ls.push({ source: 'install', text: 'password=Secret123!', stream: 'stdout' });
    const line = ls.lines()[0]!;
    expect(line.text).not.toContain('Secret123');
  });
});
