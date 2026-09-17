import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RadioGroup, Radio } from '../index';

describe('Radio', () => {
  it('点击选择某一项', async () => {
    const onChange = vi.fn();
    render(
      <RadioGroup name="g" onChange={onChange}>
        <Radio value="a" label="A" />
        <Radio value="b" label="B" />
      </RadioGroup>,
    );
    await userEvent.click(screen.getByLabelText('B'));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.getByLabelText('B')).toBeChecked();
    expect(screen.getByLabelText('A')).not.toBeChecked();
  });

  it('方向键在组内导航', async () => {
    const onChange = vi.fn();
    render(
      <RadioGroup name="g" defaultValue="a" onChange={onChange}>
        <Radio value="a" label="A" />
        <Radio value="b" label="B" />
      </RadioGroup>,
    );
    const a = screen.getByLabelText('A');
    a.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByLabelText('B')).toBeChecked();
  });
});
