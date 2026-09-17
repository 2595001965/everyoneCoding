/**
 * 项目类型探测：依据根目录文件清单识别 node / python / java / go / unknown。
 *
 * 探测是纯函数（仅看文件名清单），便于测试覆盖 4 类项目，不触碰文件系统。
 */

export type ProjectKind = 'node' | 'python' | 'java' | 'go' | 'unknown';

export const PROJECT_KINDS: readonly ProjectKind[] = ['node', 'python', 'java', 'go', 'unknown'];

export interface ProjectProfile {
  kind: ProjectKind;
  label: string;
  installCmd: string | null;
  startCmd: string | null;
  portHint: number | null;
  envHints: string[];
  evidence: string[];
  confidence: number;
  requiresManualCommand: boolean;
}

interface Rule {
  kind: ProjectKind;
  label: string;
  evidence: string[];
  installCmd: string | null;
  startCmd: string | null;
  portHint: number | null;
  envHints: string[];
}

const RULES: readonly Rule[] = [
  {
    kind: 'node',
    label: 'Node.js 项目',
    evidence: ['package.json', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'],
    installCmd: 'npm install',
    startCmd: 'npm run dev',
    portHint: 3000,
    envHints: ['PORT', 'NODE_ENV'],
  },
  {
    kind: 'python',
    label: 'Python 项目',
    evidence: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'],
    installCmd: 'pip install -r requirements.txt',
    startCmd: 'python app.py',
    portHint: 8000,
    envHints: ['PORT', 'PYTHONUNBUFFERED'],
  },
  {
    kind: 'java',
    label: 'Java 项目',
    evidence: ['pom.xml', 'build.gradle', 'build.gradle.kts'],
    installCmd: 'mvn install -DskipTests',
    startCmd: 'java -jar target/app.jar',
    portHint: 8080,
    envHints: ['PORT', 'JAVA_OPTS'],
  },
  {
    kind: 'go',
    label: 'Go 项目',
    evidence: ['go.mod', 'go.sum', 'main.go'],
    installCmd: 'go mod download',
    startCmd: 'go run .',
    portHint: 8080,
    envHints: ['PORT', 'GIN_MODE'],
  },
];

/** files 为项目根目录下的文件名清单（探测是纯函数，便于测试 4 类项目）。 */
export function detectProjectType(files: readonly string[]): ProjectProfile {
  const present = new Set(files);
  let best: { rule: Rule; matches: number } | null = null;
  for (const rule of RULES) {
    const matches = rule.evidence.filter((f) => present.has(f)).length;
    if (matches === 0) continue;
    if (best === null || matches > best.matches) best = { rule, matches };
  }
  if (best === null) {
    return {
      kind: 'unknown',
      label: '未知项目类型',
      installCmd: null,
      startCmd: null,
      portHint: null,
      envHints: [],
      evidence: [],
      confidence: 0,
      requiresManualCommand: true,
    };
  }
  const { rule, matches } = best;
  const confidence = Math.min(1, matches / rule.evidence.length);
  return {
    kind: rule.kind,
    label: rule.label,
    installCmd: rule.installCmd,
    startCmd: rule.startCmd,
    portHint: rule.portHint,
    envHints: rule.envHints,
    evidence: rule.evidence.filter((f) => present.has(f)),
    confidence,
    requiresManualCommand: false,
  };
}
