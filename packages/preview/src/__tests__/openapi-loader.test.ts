import { describe, expect, it } from 'vitest';
import {
  type LoadedOpenApi,
  OpenApiParseError,
  createFallbackOpenApi,
  matchRoute,
  parseOpenApiDocument,
  parseYamlSubset,
} from '../mock/openapi-loader';

const JSON_DOC = `{
  "openapi": "3.0.0",
  "info": { "title": "Demo", "version": "1.0.0" },
  "paths": {
    "/users/{id}": {
      "get": {
        "operationId": "getUser",
        "summary": "获取用户",
        "tags": ["user"],
        "responses": {
          "200": {
            "description": "ok",
            "content": {
              "application/json": {
                "schema": { "$ref": "#/components/schemas/User" }
              }
            }
          }
        }
      }
    }
  },
  "components": {
    "schemas": {
      "User": {
        "type": "object",
        "properties": { "id": { "type": "string" }, "name": { "type": "string" } }
      }
    }
  }
}`;

const YAML_DOC = `openapi: 3.0.0
info:
  title: Demo
  version: 1.0.0
paths:
  /users/{id}:
    get:
      operationId: getUser
      summary: 获取用户
      tags:
        - user
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
components:
  schemas:
    User:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
`;

const ALLOF_DOC = `openapi: 3.0.0
info:
  title: A
  version: 1.0.0
paths:
  /item:
    get:
      operationId: getItem
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                allOf:
                  - $ref: '#/components/schemas/Base'
                  - type: object
                    properties:
                      extra:
                        type: string
components:
  schemas:
    Base:
      type: object
      properties:
        id:
          type: string
`;

describe('OpenAPI JSON 解析', () => {
  it('解析 JSON 文档得到标题与路由', () => {
    const doc = parseOpenApiDocument(JSON_DOC);
    expect(doc.title).toBe('Demo');
    expect(doc.version).toBe('1.0.0');
    expect(doc.routes).toHaveLength(1);
  });

  it('解析出的路由携带 operationId / summary / tags', () => {
    const doc = parseOpenApiDocument(JSON_DOC);
    const route = doc.routes[0]!;
    expect(route.method).toBe('GET');
    expect(route.path).toBe('/users/{id}');
    expect(route.operationId).toBe('getUser');
    expect(route.summary).toBe('获取用户');
    expect(route.tags).toEqual(['user']);
  });

  it('解析 $ref 得到合并后的响应 schema', () => {
    const doc = parseOpenApiDocument(JSON_DOC);
    const route = doc.routes[0]!;
    expect(route.responseSchema).not.toBeNull();
    expect(route.responseSchema?.properties?.id).toBeDefined();
    expect(route.responseSchema?.properties?.name).toBeDefined();
  });
});

describe('OpenAPI YAML 解析', () => {
  it('解析 YAML 文档与 JSON 等价（标题/路由数）', () => {
    const doc = parseOpenApiDocument(YAML_DOC);
    expect(doc.title).toBe('Demo');
    expect(doc.routes).toHaveLength(1);
  });

  it('YAML 中 $ref 同样被解析', () => {
    const doc = parseOpenApiDocument(YAML_DOC);
    const route = doc.routes[0]!;
    expect(route.responseSchema?.properties?.id).toBeDefined();
    expect(route.responseSchema?.properties?.name).toBeDefined();
  });

  it('解析 YAML 子集基础结构（map / seq / 引号键）', () => {
    const value = parseYamlSubset(YAML_DOC) as Record<string, unknown>;
    expect(typeof value['info']).toBe('object');
    const paths = value['paths'] as Record<string, unknown>;
    expect(paths['/users/{id}']).toBeDefined();
  });

  it('解析 allOf 合并多个 schema 的属性', () => {
    const doc = parseOpenApiDocument(ALLOF_DOC) as LoadedOpenApi;
    const route = doc.routes[0]!;
    expect(route.responseSchema?.properties?.id).toBeDefined();
    expect(route.responseSchema?.properties?.extra).toBeDefined();
  });
});

describe('路由匹配', () => {
  it('按路径参数归一匹配并提取 params', () => {
    const doc = parseOpenApiDocument(JSON_DOC);
    const matched = matchRoute(doc.routes, 'GET', '/users/42');
    expect(matched).not.toBeNull();
    expect(matched?.params.id).toBe('42');
  });

  it('方法大小写不敏感', () => {
    const doc = parseOpenApiDocument(JSON_DOC);
    const matched = matchRoute(doc.routes, 'get', '/users/42');
    expect(matched).not.toBeNull();
  });

  it('无匹配返回 null', () => {
    const doc = parseOpenApiDocument(JSON_DOC);
    expect(matchRoute(doc.routes, 'GET', '/nope')).toBeNull();
    expect(matchRoute(doc.routes, 'POST', '/users/42')).toBeNull();
  });
});

describe('兜底与非法输入', () => {
  it('createFallbackOpenApi 提供 /health 与 /login', () => {
    const spec = createFallbackOpenApi();
    expect(spec.routes).toHaveLength(2);
    const methods = spec.routes.map((r) => `${r.method} ${r.path}`).sort();
    expect(methods).toEqual(['GET /health', 'POST /login'].sort());
  });

  it('空文档（顶层 null）抛 OpenApiParseError', () => {
    expect(() => parseOpenApiDocument('')).toThrow(OpenApiParseError);
  });

  it('非法 JSON 抛 OpenApiParseError', () => {
    expect(() => parseOpenApiDocument('{ not json ')).toThrow(OpenApiParseError);
  });

  it('JSON 顶层为数组抛 OpenApiParseError', () => {
    expect(() => parseOpenApiDocument('[1,2,3]')).toThrow(OpenApiParseError);
  });
});
