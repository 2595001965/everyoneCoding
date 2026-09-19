import { describe, expect, it } from 'vitest';
import {
  PathEscapeError,
  PathGuard,
  hasIllegalChars,
  normalizePath,
  resolveInWorkspace,
} from '../path-guard';

const CTRL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);

describe('路径归一化', () => {
  it('统一分隔符并解析 . 与 ..', () => {
    expect(normalizePath('a\\b\\c')).toBe('a/b/c');
    expect(normalizePath('a/./b/../c')).toBe('a/c');
    expect(normalizePath('/root/a/../b/')).toBe('/root/b');
  });

  it('Windows 盘符只作为前缀出现一次', () => {
    expect(normalizePath('C:\\tmp\\x')).toBe('C:/tmp/x');
    expect(normalizePath('C:/tmp/../tmp2')).toBe('C:/tmp2');
  });

  it('识别非法控制字符', () => {
    expect(hasIllegalChars('normal/path')).toBe(false);
    expect(hasIllegalChars(`bad${CTRL}path`)).toBe(true);
    expect(hasIllegalChars(`bad${BELL}name`)).toBe(true);
  });
});

describe('PathGuard', () => {
  const guard = new PathGuard('C:/workspace');

  it('工作区内路径可解析', () => {
    expect(guard.resolve('C:/workspace/a/b.txt')).toBe('C:/workspace/a/b.txt');
    expect(guard.isWithin('C:/workspace/a')).toBe(true);
  });

  it('根目录自身视为内部', () => {
    expect(guard.isWithin('C:/workspace')).toBe(true);
    expect(guard.resolve('C:/workspace')).toBe('C:/workspace');
  });

  it('.. 逃逸被拒绝', () => {
    expect(() => guard.resolve('C:/workspace/../../Windows/System32')).toThrow(PathEscapeError);
    expect(guard.isWithin('C:/workspace/../secret')).toBe(false);
  });

  it('绝对路径穿越被拒绝', () => {
    expect(() => guard.resolve('D:/other/file.txt')).toThrow(PathEscapeError);
    expect(() => guard.resolve('/etc/passwd')).toThrow(PathEscapeError);
  });

  it('非法字符被拒绝', () => {
    expect(() => guard.resolve(`C:/workspace/bad${CTRL}name`)).toThrow(PathEscapeError);
  });

  it('同类前缀目录不算越界误判', () => {
    expect(guard.isWithin('C:/workspace2/x')).toBe(false);
  });

  it('relative 返回相对路径', () => {
    expect(guard.relative('C:/workspace/a/b.txt')).toBe('a/b.txt');
    expect(guard.relative('C:/workspace')).toBe('.');
  });

  it('便捷函数 resolveInWorkspace 越界直接抛错', () => {
    expect(() => resolveInWorkspace('C:/workspace', 'C:/elsewhere')).toThrow(PathEscapeError);
    expect(resolveInWorkspace('C:/workspace', 'C:/workspace/ok')).toBe('C:/workspace/ok');
  });
});
