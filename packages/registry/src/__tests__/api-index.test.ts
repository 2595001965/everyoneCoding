import { describe, expect, it } from 'vitest';
import { candidateRoutes, scanApiSources, type ApiSourceFile } from '../index';
import { parseOpenApiDocument } from '../../../preview/src/index';

const files = (input: Record<string, string>): ApiSourceFile[] =>
  Object.entries(input).map(([path, content]) => ({ path, content, modifiedAt: null }));

describe('V2-D04 静态 HTTP 索引', () => {
  it('合并跨文件/多级挂载和参数路径，Service 方法不是 HTTP 接口', () => {
    const result = scanApiSources(
      files({
        'package.json': '{}',
        'routes.ts': `import {Router} from 'express'; export const users = Router(); users.get('/:id', auth, loadUser); class UserService { get(id: string) {} }`,
        'app.ts': `import express, { Router } from 'express'; import {users} from './routes'; const app=express(); const v1=Router(); const PREFIX='/api'; v1.use('/users', users); app.use(PREFIX, v1); app.listen(3001);`,
        'view.tsx': `fetch('/api/users/12'); fetch('/api/users/13'); function fake(fetch: Function) { fetch('/do-not-index'); } // fetch('/comment')`,
      }),
    );
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toMatchObject({
      normalizedPath: '/api/users/{id}',
      status: 'active',
      authentication: ['auth'],
    });
    expect(result.endpoints[0]!.evidence.filter((e) => e.kind === 'configuration')).toHaveLength(2);
    expect(result.calls).toHaveLength(2);
    expect(candidateRoutes(result.calls[0]!, result.endpoints, result.services)).toHaveLength(1);
  });
  it('同路径的不同服务不合并，未指定服务有多个候选', () => {
    const result = scanApiSources(
      files({
        'a/package.json': '{}',
        'b/package.json': '{}',
        'a/app.ts': `import express from 'express'; const app=express(); app.get('/users/:id', a); app.listen(3001);`,
        'b/app.ts': `import express from 'express'; const app=express(); app.get('/users/:id', b); app.listen(3002);`,
        'web.ts': `fetch('/users/7'); fetch('https://outside.example/users/7');`,
      }),
    );
    expect(result.endpoints).toHaveLength(2);
    expect(new Set(result.endpoints.map((e) => e.serviceId)).size).toBe(2);
    expect(candidateRoutes(result.calls[0]!, result.endpoints, result.services)).toHaveLength(2);
    expect(candidateRoutes(result.calls[1]!, result.endpoints, result.services)).toHaveLength(0);
  });
  it('axios 导入实例/baseURL 与本地 Vite 代理关联服务；rewrite 不执行', () => {
    const result = scanApiSources(
      files({
        'api/app.ts': `import express from 'express'; const app=express(); app.get('/api/users/:id', getUser); app.listen(3001);`,
        'web/http.ts': `import axios from 'axios'; export const client=axios.create({baseURL:'http://localhost:3001/api'});`,
        'web/view.ts': `import {client} from './http'; client.get('/users/8'); fetch('/api/users/9'); fetch('/rewrite/users');`,
        'web/vite.config.ts': `export default {server:{proxy:{'/api':{target:'http://localhost:3001'}, '/rewrite':{target:'http://localhost:3001',rewrite:(p)=>p.replace('/rewrite','/api')}}}};`,
      }),
    );
    expect(result.calls).toHaveLength(3);
    expect(candidateRoutes(result.calls[0]!, result.endpoints, result.services)).toHaveLength(1);
    expect(candidateRoutes(result.calls[1]!, result.endpoints, result.services)).toHaveLength(1);
    expect(result.calls[2]).toMatchObject({
      dynamic: true,
      reason: expect.stringContaining('rewrite'),
    });
  });
  it('动态 URL/缺少环境变量/动态挂载保留原始证据，不能冒充已解析', () => {
    const result = scanApiSources(
      files({
        'app.ts': `import express, {Router} from 'express'; const app=express(); const router=Router(); router.get('/u', handler); app.use(process.env.PREFIX, router);`,
        'view.ts':
          "import axios from 'axios'; const client=axios.create({baseURL:import.meta.env.API_URL}); client.get('/u'); fetch(`/users/${id}`); fetch(url, {method:verb});",
      }),
    );
    expect(result.endpoints[0]!.status).toBe('pending_confirmation');
    expect(result.calls.every((c) => c.dynamic)).toBe(true);
    expect(result.calls[1]!.expression).toContain('${id}');
    expect(result.calls[2]!.method).toBeNull();
  });
  it('Nest 全局/Controller 前缀、参数/认证与 Service 实现线索', () => {
    const result = scanApiSources(
      files({
        'controller.ts': `import {Controller,Get,Param,UseGuards} from '@nestjs/common'; @Controller('users') @UseGuards(AuthGuard) class UserController { @Get(':id') getUser(@Param('id') id:string): User { return this.userService.find(id); } }`,
        'main.ts': `import {NestFactory} from '@nestjs/core'; async function bootstrap(){ const app=await NestFactory.create(AppModule); app.setGlobalPrefix('api'); app.listen(3004); }`,
      }),
    );
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toMatchObject({
      normalizedPath: '/api/users/{id}',
      response: 'User',
      status: 'active',
    });
    expect(result.endpoints[0]!.implementation[0]!.symbol).toContain('Service.find');
    expect(result.endpoints[0]!.authentication.join()).toContain('UseGuards');
  });
  it('FastAPI 显式 APIRouter + include_router，跳过注释/三引号假路由', () => {
    const result = scanApiSources(
      files({
        'routes.py': `from fastapi import APIRouter\nrouter = APIRouter(prefix='/users')\n@router.get('/{id}')\ndef get_user(id: str):\n    return {'id':id}\n\n# @router.post('/fake')\ntext = """@router.get('/fake2')"""\n`,
        'main.py': `from fastapi import FastAPI\nfrom routes import router\napp = FastAPI()\napp.include_router(router, prefix='/api')\n`,
      }),
    );
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toMatchObject({
      normalizedPath: '/api/users/{id}',
      status: 'active',
    });
    expect(result.warnings.join()).toContain('词法');
  });
  it('复用本地 OpenAPI 合并契约参数/响应/security/tag，忽略 $ref 外部地址', () => {
    const result = scanApiSources(
      files({
        'app.ts': `import express from 'express'; const app=express(); app.get('/api/users/:id', load);`,
        'openapi.json': JSON.stringify({
          openapi: '3.0.0',
          servers: [{ url: '/api' }],
          security: [{ bearer: [] }],
          paths: {
            '/users/{id}': {
              parameters: [{ name: 'id', in: 'path' }],
              get: {
                operationId: 'getUser',
                tags: ['用户管理'],
                responses: {
                  200: { content: { 'application/json': { schema: { type: 'object' } } } },
                },
              },
            },
          },
        }),
      }),
      parseOpenApiDocument,
    );
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]!.tags).toEqual(['用户管理']);
    expect(result.endpoints[0]!.parameters).toMatchObject({
      parameters: [{ name: 'id', in: 'path' }],
    });
    expect(result.endpoints[0]!.response).toMatchObject({ type: 'object' });
    expect(result.endpoints[0]!.authentication.join()).toContain('bearer');
  });
  it('语法错误/坏契约标记扫描不完整，避免误删旧索引', () => {
    expect(scanApiSources(files({ 'app.ts': 'const app = express(;' })).complete).toBe(false);
    expect(
      scanApiSources(files({ 'openapi.json': '{"openapi":invalid}' }), parseOpenApiDocument)
        .complete,
    ).toBe(false);
  });
  it('CommonJS Router 与 route 链复用挂载前缀，HEAD/OPTIONS 仍是 HTTP 路由', () => {
    const result = scanApiSources(
      files({
        'routes.cjs': `const {Router}=require('express'); const router=Router(); router.route('/:id').get(load).post(save); router.head('/:id',head); router.options('/',options); module.exports=router;`,
        'app.cjs': `const express=require('express'); const routes=require('./routes.cjs'); const app=express(); app.use('/api/users',routes);`,
      }),
    );
    expect(result.endpoints.map((e) => [e.method, e.normalizedPath]).sort()).toEqual([
      ['GET', '/api/users/{id}'],
      ['HEAD', '/api/users/{id}'],
      ['OPTIONS', '/api/users'],
      ['POST', '/api/users/{id}'],
    ]);
  });
  it('本地自定义 fetch、遮蔽 axios 不误识别，支持显式全局 fetch', () => {
    const result = scanApiSources(
      files({
        'custom.ts': `import {fetch} from './custom-client'; fetch('/not-http');`,
        'client.ts': `import axios from 'axios'; function local(axios:Function){axios('/not-http'); axios.get('/not-http');} globalThis.fetch('/global'); window.fetch('/window',{method:'POST'});`,
      }),
    );
    expect(result.calls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/global'],
      ['POST', '/window'],
    ]);
  });
  it('OpenAPI 多 server 不合并服务，动态 server 不合并有效路由', () => {
    const result = scanApiSources(
      files({
        'api/app.ts': `import express from 'express'; const app=express(); app.head('/users',head); app.listen(3001);`,
        'api/openapi.json': JSON.stringify({
          openapi: '3.0.0',
          servers: [
            { url: 'http://localhost:3001' },
            { url: 'http://localhost:3002' },
            { url: 'http://localhost:3001/{prefix}' },
          ],
          paths: {
            '/users': {
              head: { operationId: 'usersHead', responses: { 200: { description: 'ok' } } },
            },
          },
        }),
      }),
      parseOpenApiDocument,
    );
    expect(result.endpoints).toHaveLength(3);
    expect(result.endpoints.filter((e) => e.status === 'active')).toHaveLength(2);
    expect(
      new Set(result.endpoints.filter((e) => e.status === 'active').map((e) => e.serviceId)).size,
    ).toBe(2);
    expect(
      result.endpoints.find((e) => e.status === 'pending_confirmation')?.normalizedPath,
    ).toContain('__unresolved__');
  });
  it('FastAPI 工厂和缺少函数的装饰器保留待确认，不能冒充静态完整路由', () => {
    const result = scanApiSources(
      files({
        'factory.py': `from fastapi import FastAPI\ndef create():\n    app=FastAPI()\n    @app.get('/nested')\n    def nested():\n        pass\n    return app\n`,
        'orphan.py': `from fastapi import FastAPI\napp=FastAPI()\n@app.get('/orphan')\nother=123\n`,
      }),
    );
    expect(result.endpoints).toHaveLength(2);
    expect(result.endpoints.every((e) => e.status === 'pending_confirmation')).toBe(true);
  });
});
