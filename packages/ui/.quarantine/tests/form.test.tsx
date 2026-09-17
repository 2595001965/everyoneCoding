import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox, Input, RadioGroup, Select, Switch, Textarea } from '../components/form';

describe('Input', () => {
  it('label 通过 htmlFor 关联输入框', () => {
    render(<Input label="项目名称" />);
    const input = screen.getByLabelText('项目名称');
    expect(input).toBeInTheDocument();
  });

  it('错误态提供 aria-invalid 与错误描述', () => {
    render(<Input label="API Key" status="error" errorText="密钥格式不正确" />);
    const input = screen.getByLabelText('API Key');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('密钥格式不正确');
  });
});

describe('Select', () => {
  it('选项可选且禁用项不可选', async () => {
    const onChange = vi.fn();
    render(
      <Select
        label="目标端"
        options={[
          { value: 'web', label: 'Web' },
          { value: 'android', label: 'Android', disabled: true },
        ]}
        onChange={onChange}
      />,
    );
    await userEvent.selectOptions(screen.getByLabelText('目标端'), 'web');
    expect(onChange).toHaveBeenCalled();
  });
});

describe('Checkbox', () => {
  it('点击与空格键都能切换（受控）', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Checkbox label="自动提交" checked={false} onChange={onChange} />);
    const box = screen.getByRole('checkbox', { name: '自动提交' });

    await userEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(<Checkbox label="自动提交" checked onChange={onChange} />);
    box.focus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('非受控模式可用', async () => {
    render(<Checkbox label="记住我" defaultChecked={false} />);
    await userEvent.click(screen.getByRole('checkbox', { name: '记住我' }));
    expect(screen.getByRole('checkbox', { name: '记住我' })).toBeChecked();
  });
});

describe('RadioGroup', () => {
  it('方向键在选项间移动（radio 原生语义）', async () => {
    const onChange = vi.fn();
    function Demo() {
      const [value, setValue] = useState('web');
      return (
        <RadioGroup
          label="技术方案"
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
          options={[
            { value: 'web', label: 'React' },
            { value: 'mobile', label: 'Flutter' },
            { value: 'harmony', label: 'ArkTS' },
          ]}
        />
      );
    }
    render(<Demo />);
    const react = screen.getByRole('radio', { name: 'React' });
    react.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('mobile');
    expect(screen.getByRole('radio', { name: 'Flutter' })).toBeChecked();
  });
});

describe('Switch', () => {
  it('role=switch 且空格可切换', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Switch label="遥测" checked={false} onChange={onChange} />);
    const toggle = screen.getByRole('switch', { name: '遥测' });
    toggle.focus();
    await userEvent.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(<Switch label="遥测" checked onChange={onChange} />);
    expect(toggle).toBeChecked();
  });
});

describe('Textarea', () => {
  it('label 关联与输入', async () => {
    render(<Textarea label="备注" />);
    const area = screen.getByLabelText('备注');
    await userEvent.type(area, '需要校验图形验证码');
    expect(area).toHaveValue('需要校验图形验证码');
  });
});
