import { describe, expect, it } from 'vitest';
import { PROJECT_KINDS, detectProjectType } from '../backend/project-detector';

describe('项目类型识别', () => {
  it('node：package.json + pnpm-lock.yaml', () => {
    const p = detectProjectType(['package.json', 'pnpm-lock.yaml', 'src/index.ts']);
    expect(p.kind).toBe('node');
    expect(p.installCmd).toBe('npm install');
    expect(p.startCmd).toBe('npm run dev');
    expect(p.portHint).toBe(3000);
    expect(p.requiresManualCommand).toBe(false);
    expect(p.confidence).toBeGreaterThan(0);
  });

  it('python：requirements.txt', () => {
    const p = detectProjectType(['requirements.txt', 'app.py']);
    expect(p.kind).toBe('python');
    expect(p.installCmd).toBe('pip install -r requirements.txt');
    expect(p.startCmd).toBe('python app.py');
    expect(p.portHint).toBe(8000);
  });

  it('java：pom.xml', () => {
    const p = detectProjectType(['pom.xml', 'src/main/Main.java']);
    expect(p.kind).toBe('java');
    expect(p.installCmd).toBe('mvn install -DskipTests');
    expect(p.startCmd).toBe('java -jar target/app.jar');
    expect(p.portHint).toBe(8080);
  });

  it('go：go.mod + main.go', () => {
    const p = detectProjectType(['go.mod', 'main.go']);
    expect(p.kind).toBe('go');
    expect(p.installCmd).toBe('go mod download');
    expect(p.startCmd).toBe('go run .');
    expect(p.portHint).toBe(8080);
  });

  it('unknown：空清单', () => {
    const p = detectProjectType([]);
    expect(p.kind).toBe('unknown');
    expect(p.installCmd).toBeNull();
    expect(p.requiresManualCommand).toBe(true);
    expect(p.confidence).toBe(0);
  });

  it('多证据命中取最匹配类型', () => {
    const p = detectProjectType(['package.json', 'pom.xml']);
    expect(p.kind).toBe('node');
    expect(p.evidence).toContain('package.json');
  });
});

describe('PROJECT_KINDS', () => {
  it('包含全部五类', () => {
    expect(PROJECT_KINDS).toEqual(['node', 'python', 'java', 'go', 'unknown']);
  });
});
