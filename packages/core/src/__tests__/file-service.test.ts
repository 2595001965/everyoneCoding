import { MockShell } from '@ec/shell-api';
import { beforeEach, describe, expect, it } from 'vitest';
import { FileService } from '../file-service';
import { PathEscapeError } from '../path-guard';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('FileService 原子写', () => {
  let shell: MockShell;
  let service: FileService;

  beforeEach(() => {
    shell = new MockShell({ dataDir: 'C:/tmp/ec-core' });
    service = new FileService({ shell, guardRoot: 'C:/workspace' });
  });

  it('写入成功后可完整读回', async () => {
    await service.writeAtomic('C:/workspace/a.txt', 'hello');
    expect(await service.readText('C:/workspace/a.txt')).toBe('hello');
  });

  it('写入中途失败（模拟断电）不产生目标文件', async () => {
    shell.fs.failNextAtomicWriteAt = 'after-tmp';
    await expect(service.writeAtomic('C:/workspace/a.txt', 'x')).rejects.toThrow();
    expect(await service.exists('C:/workspace/a.txt')).toBe(false);
  });

  it('rename 前失败保留旧内容', async () => {
    await service.writeAtomic('C:/workspace/keep.txt', 'old');
    shell.fs.failNextAtomicWriteAt = 'before-rename';
    await expect(service.writeAtomic('C:/workspace/keep.txt', 'new')).rejects.toThrow();
    expect(await service.readText('C:/workspace/keep.txt')).toBe('old');
  });

  it('路径逃逸一律被拒绝', async () => {
    await expect(service.writeAtomic('C:/workspace/../../outside.txt', 'x')).rejects.toThrow(
      PathEscapeError,
    );
    await expect(service.readText('D:/other')).rejects.toThrow(PathEscapeError);
  });

  it('同一文件并发写串行化，不出现交叉写入', async () => {
    const inner = shell.fs.writeAtomic.bind(shell.fs);
    let concurrent = 0;
    let maxConcurrent = 0;
    shell.fs.writeAtomic = async (path, data, options) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(5);
      try {
        await inner(path, data, options);
      } finally {
        concurrent -= 1;
      }
    };

    await Promise.all([
      service.writeAtomic('C:/workspace/race.txt', 'a'),
      service.writeAtomic('C:/workspace/race.txt', 'b'),
      service.writeAtomic('C:/workspace/race.txt', 'c'),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(await service.readText('C:/workspace/race.txt')).toBe('c');
  });

  it('流式写入按块合并后落盘', async () => {
    async function* chunks() {
      yield 'hello ';
      yield 'world';
    }
    const size = await service.writeStream('C:/workspace/stream.txt', chunks());
    expect(size).toBe(11);
    expect(await service.readText('C:/workspace/stream.txt')).toBe('hello world');
  });

  it('readJson 解析并支持校验回调', async () => {
    await service.writeAtomic('C:/workspace/data.json', JSON.stringify({ ok: true }));
    expect(await service.readJson<{ ok: boolean }>('C:/workspace/data.json')).toEqual({ ok: true });
  });

  it('list / copy / remove 可用', async () => {
    await service.writeAtomic('C:/workspace/dir/a.txt', 'x');
    expect(await service.list('C:/workspace/dir')).toHaveLength(1);
    await service.copy('C:/workspace/dir/a.txt', 'C:/workspace/dir/b.txt');
    expect(await service.exists('C:/workspace/dir/b.txt')).toBe(true);
    await service.remove('C:/workspace/dir');
    expect(await service.exists('C:/workspace/dir')).toBe(false);
  });
});
