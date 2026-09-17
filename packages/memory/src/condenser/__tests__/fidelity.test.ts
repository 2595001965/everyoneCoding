import { describe, test, expect } from 'vitest';
import { createLoginPageDslFixture } from '../page-dsl';
import { condensePage } from '../condenser';
import { evaluateFidelity, reconstructFromSummary } from './fidelity';

describe('保真度评估', () => {
  test('朴素重建器 matchRate ≥ 0.9', () => {
    const dsl = createLoginPageDslFixture();
    const summary = condensePage(dsl);
    const report = evaluateFidelity(dsl, summary, reconstructFromSummary);
    console.info(
      `[fidelity] reconstruction matchRate=${report.matchRate.toFixed(2)} missing=${report.missing.length} extra=${report.extra.length}`,
    );
    expect(report.matchRate).toBeGreaterThanOrEqual(0.9);
  });
});
