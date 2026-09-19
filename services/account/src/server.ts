/**
 * 服务端入口：按环境变量装配并监听端口。
 * 本文件仅在直接运行时启动监听；测试通过 app.ts 的 buildApp + inject 运行。
 */
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';

const config = loadConfig();

async function main(): Promise<void> {
  const app = await buildApp(config);
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`账号服务端已启动：http://${config.host}:${config.port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main();
}
