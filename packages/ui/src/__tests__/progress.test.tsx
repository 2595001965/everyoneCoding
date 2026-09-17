import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Progress } from '../index';

describe('Progress', () => {
  it('渲染 role=progressbar 与 aria-valuenow', () => {
    const { container } = render(<Progress value={40} max={100} />);
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('indeterminate 不暴露具体数值但保持可达', () => {
    const { container } = render(<Progress indeterminate />);
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(container.querySelector('.ec-progress--indeterminate')).toBeTruthy();
  });
});
