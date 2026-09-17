import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

describe('portal debug', () => {
  it('portal 挂载点', () => {
    const { container } = render(
      ReactDOM.createPortal(<div className="ec-overlay">x</div>, document.body),
    );
    console.log('in container:', container.querySelector('.ec-overlay') !== null);
    console.log('in body:', document.body.querySelector('.ec-overlay') !== null);
    expect(true).toBe(true);
  });
});
