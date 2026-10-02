import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { injectDomSelector } from '@ec/preview';
import type { DomInspection } from './dom-inspection';
import type { ProjectPaths } from './paths';

export const DOM_COMPILE_PATH = '/__ec_dom_compile';
const MAX_BYTES = 1_048_576;

/** A private, loopback-only compiler port. It is never exposed through the page bridge. */
export class DomViteBridge {
  private readonly capabilities = new Set<string>();
  private readonly configs: string[] = [];
  constructor(
    private readonly projectId: string,
    private readonly paths: ProjectPaths,
    private readonly inspection: DomInspection,
  ) {}

  clear(): void {
    this.capabilities.clear();
    for (const file of this.configs.splice(0)) {
      try {
        unlinkSync(file);
      } catch {
        /* Already removed during workspace cleanup. */
      }
    }
  }

  prepare(
    command: string,
    args: readonly string[],
    cwd: string,
    previewUrl: string,
  ): string[] | null {
    const run = /^(npm|pnpm|yarn) run ([\w:-]+)$/.exec(command.trim());
    let script = command.trim();
    if (run) {
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>;
        };
        script = pkg.scripts?.[run[2]!] ?? '';
      } catch {
        return null;
      }
    }
    // Preserve the confirmed script. Compound commands and custom config/root flags are unsupported,
    // rather than silently replacing the user's startup implementation.
    if (
      !/^vite(?:\s+--(?:host(?:\s+(?:127\.0\.0\.1|localhost|0\.0\.0\.0))?|strictPort))*$/.test(
        script,
      ) ||
      args.some((arg) => /^(?:--config|--root)(?:=|$)/.test(arg))
    )
      return null;
    const capability = randomUUID();
    const dir = this.paths.projectDir(this.projectId, 'meta', 'dom-dev');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `vite-${randomUUID()}.mjs`);
    const endpoint = new URL(DOM_COMPILE_PATH, previewUrl).href;
    writeFileSync(file, viteConfigBridge(cwd, endpoint, capability), { flag: 'wx' });
    this.configs.push(file);
    this.capabilities.add(capability);
    // npm consumes flags unless there is a -- separator; pnpm/yarn already forward script flags.
    return [
      ...(run?.[1] === 'npm' && !args.includes('--') ? ['--'] : []),
      ...args,
      '--config',
      file,
    ];
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const remote = req.socket.remoteAddress;
    const capability = req.headers['x-ec-compile'];
    if (
      req.method !== 'POST' ||
      req.headers.origin !== undefined ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '') ||
      typeof capability !== 'string' ||
      !this.capabilities.has(capability)
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk as Uint8Array);
        size += bytes.length;
        if (size > MAX_BYTES) throw new Error('编译输入过大');
        chunks.push(bytes);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (
        typeof input['id'] !== 'string' ||
        typeof input['code'] !== 'string' ||
        !['html', 'module'].includes(String(input['kind']))
      )
        throw new Error('非法编译输入');
      const root = this.paths.codeRoot(this.projectId);
      const path = this.paths.relative(root, input['id']);
      const file = this.paths.inside(root, path);
      const original = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      const kind =
        input['kind'] === 'html' && /\.html$/.test(path)
          ? 'static_html'
          : /\.[jt]sx$/.test(path)
            ? 'react_compiled'
            : /\.vue$/.test(path)
              ? 'vue_compiled'
              : null;
      // Earlier transforms, virtual modules and aliases cannot masquerade as original-source evidence.
      let code = input['code'];
      if (kind && code === original) code = this.inspection.registry.instrument(code, path, kind);
      if (input['kind'] === 'html' && this.inspection.session)
        code = injectDomSelector(code, this.inspection.session);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ code }));
    } catch {
      res.writeHead(400);
      res.end();
    }
  }
}

function viteConfigBridge(cwd: string, endpoint: string, capability: string): string {
  return `import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {dirname,join} from 'node:path';
const require = createRequire(${JSON.stringify(join(cwd, 'package.json'))});
const {loadConfigFromFile} = await import(pathToFileURL(join(dirname(require.resolve('vite/package.json')),'dist/node/index.js')).href);
async function compile(code,id,kind){
  const response=await fetch(${JSON.stringify(endpoint)}, {method:'POST',headers:{'content-type':'application/json','x-ec-compile':${JSON.stringify(capability)}},body:JSON.stringify({code,id,kind}),signal:AbortSignal.timeout(5000)});
  if(!response.ok) return code;
  return (await response.json()).code;
}
export default async function(env){
  const original=await loadConfigFromFile(env,undefined,${JSON.stringify(cwd)});
  const config=original?.config??{};
  const plugin={name:'ec-local-dom-inspection',apply:'serve',enforce:'pre',
    configureServer(server){server.middlewares.use((req,res,next)=>{let path;try{path=decodeURIComponent(req.url??'').replace(/\\\\/g,'/')}catch{res.statusCode=400;res.end();return}if(path.includes('/meta/dom-dev/')||path.includes('/.vite-temp/')){res.statusCode=403;res.end();return}next()})},
    async transform(code,id){if(id.includes('?')||!/\\.(?:[jt]sx|vue)$/.test(id)||id.includes('/node_modules/'))return null;return {code:await compile(code,id,'module'),map:null}},
    transformIndexHtml:{order:'pre',handler:(html,ctx)=>compile(html,ctx.filename,'html')}
  };
  return {...config,plugins:[plugin,...(config.plugins??[])]};
}
`;
}
