import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Tooltip } from '../components/Tooltip';
import * as React from 'react';

describe('tooltip debug', () => {
  it('react onFocus 语义', () => {
    let got = false;
    const { container: c2 } = render(<button onFocus={() => { got = true; }}>直测</button>);
    (c2.querySelector('button') as HTMLButtonElement).focus();
    console.log('react onFocus fired:', got);
    expect(true).toBe(true);
  });

  it('focus 显示', () => {
    const { container } = render(
      <Tooltip content="帮助提示">
        <button>悬停</button>
      </Tooltip>,
    );
    const btn = container.querySelector('button') as HTMLButtonElement;
    let fired = false;
    document.addEventListener('focusin', () => { fired = true; });
    btn.focus();
    console.log('focusin fired:', fired);
    console.log('activeElement:', document.activeElement?.tagName);
    console.log('body html:', document.body.innerHTML.slice(0, 600));
    expect(true).toBe(true);
  });
});
