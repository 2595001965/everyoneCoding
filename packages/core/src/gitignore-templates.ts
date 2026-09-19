/**
 * .gitignore 模板：按技术栈生成，可组合。
 * HarmonyOS（ArkTS）模板需覆盖 .hvigor / oh_modules / build 等 hvigor 产物。
 */

export type StackId = 'node' | 'python' | 'java' | 'go' | 'flutter' | 'harmonyos-arkts';

export interface GitignoreTemplate {
  id: StackId;
  label: string;
  /** 模板正文（不含标题注释，标题由 render 生成） */
  body: string;
}

const NODE_BODY = `# 依赖
node_modules/
.pnp
.pnp.js

# 构建产物
dist/
build/
out/
.next/
.nuxt/
.output/
.vite/
*.tsbuildinfo

# 日志与调试
logs/
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# 环境变量（永不入库）
.env
.env.*
!.env.example

# 编辑器与系统
.vscode/*
!.vscode/extensions.json
.idea/
.DS_Store
Thumbs.db
`;

const PYTHON_BODY = `# 字节码
__pycache__/
*.py[cod]
*$py.class
*.so

# 虚拟环境
.venv/
venv/
env/
ENV/

# 打包与分发
build/
dist/
*.egg-info/
.eggs/

# 测试与覆盖率
.pytest_cache/
.coverage
htmlcov/
.tox/
.mypy_cache/
.ruff_cache/

# 环境变量
.env
.env.*
`;

const JAVA_BODY = `# 构建产物
target/
build/
out/
*.class
*.jar
*.war
*.ear

# Maven / Gradle
.mvn/
.gradle/
gradle-app.setting
!gradle-wrapper.jar

# 编辑器与系统
.idea/
*.iml
*.ipr
*.iws
.DS_Store
`;

const GO_BODY = `# 二进制与构建产物
*.exe
*.exe~
*.dll
*.so
*.dylib
bin/
dist/

# 测试与覆盖率
*.test
*.out
coverage.txt

# Go 工作区
go.work
go.work.sum
`;

const FLUTTER_BODY = `# Dart / Flutter
.dart_tool/
.flutter-plugins
.flutter-plugins-dependencies
.packages
.pub-cache/
.pub/
build/
coverage/

# 平台构建产物
/android/app/debug
/android/app/profile
/android/app/release
/ios/Flutter/*.xcconfig
*.iml
.idea/

# 环境变量
.env
`;

const HARMONYOS_ARKTS_BODY = `# HarmonyOS / ArkTS（hvigor 构建产物，务必忽略）
.hvigor/
oh_modules/
node_modules/
build/
**/build/
**/.preview/
**/oh_modules/

# hvigor 缓存与日志
**/.hvigor/
**/hvigor/.hvigor
**/hvigorfile.js.map
**/oh-package-lock.json5
**/.clang-format
**/.clang-tidy
**/.test/

# 编译中间产物
**/src/main/resources/base/**/*.json.bak
**/*.har
**/*.hap
**/*.hsp
**/*.app
**/ets/*.js.map
**/.cxx/

# 本地配置与密钥
local.properties
**/src/main/resources/base/element/string.json.bak
.env
`;

export const GITIGNORE_TEMPLATES: readonly GitignoreTemplate[] = [
  { id: 'node', label: 'Node.js', body: NODE_BODY },
  { id: 'python', label: 'Python', body: PYTHON_BODY },
  { id: 'java', label: 'Java', body: JAVA_BODY },
  { id: 'go', label: 'Go', body: GO_BODY },
  { id: 'flutter', label: 'Flutter', body: FLUTTER_BODY },
  { id: 'harmonyos-arkts', label: 'HarmonyOS（ArkTS）', body: HARMONYOS_ARKTS_BODY },
];

const TEMPLATE_MAP = new Map<StackId, GitignoreTemplate>(
  GITIGNORE_TEMPLATES.map((template) => [template.id, template]),
);

export function getTemplate(id: StackId): GitignoreTemplate {
  const template = TEMPLATE_MAP.get(id);
  if (!template) throw new Error(`未知的 .gitignore 模板: ${id}`);
  return template;
}

export interface RenderOptions {
  /** 额外追加的自定义规则 */
  extra?: string[];
  /** 是否写入 EveryoneCoding 固定忽略段（.ecpkg 等） */
  includeEcSection?: boolean;
}

const EC_SECTION = `# EveryoneCoding 工作区
.ecpkg
.ecpkg.tmp
*.ec-tmp
.ec-snapshots/
`;

/** 按技术栈组合生成 .gitignore 内容 */
export function renderGitignore(stacks: StackId[], options: RenderOptions = {}): string {
  const sections: string[] = ['# 由 EveryoneCoding 生成，按需调整', ''];
  for (const stack of stacks) {
    const template = getTemplate(stack);
    sections.push(`# ---- ${template.label} ----`, template.body.trim(), '');
  }
  if (options.includeEcSection ?? true) {
    sections.push(EC_SECTION.trim(), '');
  }
  if (options.extra && options.extra.length > 0) {
    sections.push('# ---- 自定义 ----', ...options.extra, '');
  }
  return `${sections
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
