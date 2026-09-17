import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Spinner } from '../index';

describe('Spinner', () => {
  it('role=status 且提供中文 aria-label', () => {
    const { container } = render(<Spinner />);
    const el = container.querySelector('[role="status"]') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-label')).toBe('加载中');
    expect(el.getAttribute('aria-live')).toBe('polite');
  });
});
