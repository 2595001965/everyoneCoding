import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AuthPage } from '../index';
import { AuthApiProvider } from '../auth-api';
import { BindingPanel } from '../BindingPanel';
import { LoginPage } from '../LoginPage';
import { createFakeAuthApi, type FakeAuthEnvironment } from './fake-auth';

let env: FakeAuthEnvironment;

beforeEach(() => {
  env = createFakeAuthApi();
});

function renderLogin(onAuthenticated = vi.fn()) {
  render(
    <AuthApiProvider api={env.api}>
      <LoginPage onAuthenticated={onAuthenticated} />
    </AuthApiProvider>,
  );
  return { onAuthenticated };
}

/** 建立本地会话（绑定面板需要令牌才可调用服务端） */
async function signIn(): Promise<void> {
  await env.api.login({ email: 'dev@example.com', password: 'Abcd1234', rememberMe: true });
}

describe('注册（FR-ACC-01 / E2E-01）', () => {
  it('弱密码与两次不一致实时提示，满足要求后可提交', async () => {
    const { onAuthenticated } = renderLogin();
    fireEvent.click(screen.getByRole('tab', { name: '注册' }));

    fireEvent.change(screen.getByLabelText('注册邮箱'), { target: { value: 'dev@example.com' } });
    fireEvent.change(screen.getByLabelText('注册密码'), { target: { value: '123' } });
    expect(screen.getByRole('status').textContent).toContain('至少 8 位');
    expect(screen.getByRole('button', { name: '注册并进入工作台' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('注册密码'), { target: { value: 'Abcd1234!xyz' } });
    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'Abcd9999' } });
    expect(screen.getByRole('status').textContent).toContain('两次输入的密码不一致');
    expect(screen.getByRole('button', { name: '注册并进入工作台' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'Abcd1234!xyz' } });
    expect(screen.getByRole('status').textContent).toContain('强度：强');
    const submit = screen.getByRole('button', { name: '注册并进入工作台' });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    expect(env.transport.calls.some((call) => call.url.endsWith('/api/auth/register'))).toBe(true);
    // 明文密码不落盘
    expect(env.secure.dump()).not.toContain('Abcd1234!xyz');
    expect(await screen.findByText(/验证邮件已发送/)).toBeTruthy();
  });
});

describe('邮箱登录与第三方入口（FR-ACC-02/03/04）', () => {
  it('邮箱登录成功回调会话', async () => {
    const { onAuthenticated } = renderLogin();
    fireEvent.change(screen.getByLabelText('登录邮箱'), { target: { value: 'dev@example.com' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'Abcd1234' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    const session = onAuthenticated.mock.calls[0]![0] as { identity: { accountId: string } };
    expect(session.identity.accountId).toBe('acc-1');
  });

  it('GitHub 登录：scope 含 read:user user:email 并交给系统浏览器', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'GitHub 登录' }));

    await waitFor(() => expect(env.system.opened).toHaveLength(1));
    const url = new URL(env.system.opened[0]!);
    expect(url.host).toBe('github.com');
    expect(url.searchParams.get('scope')).toBe('read:user user:email');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('Google 登录走 Google 授权端点', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Google 登录' }));
    await waitFor(() => expect(env.system.opened).toHaveLength(1));
    expect(new URL(env.system.opened[0]!).host).toBe('accounts.google.com');
  });

  it('微信扫码：展开二维码并请求扫码授权', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: '微信扫码' }));
    expect(await screen.findByLabelText('微信扫码登录')).toBeTruthy();
    await waitFor(() => expect(env.system.opened).toHaveLength(1));
    expect(env.system.opened[0]!).toContain('open.weixin.qq.com');
    expect(env.system.opened[0]!.endsWith('#wechat_redirect')).toBe(true);
  });
});

describe('离线本地模式（FR-ACC-05）', () => {
  it('云端不可达时展示横幅且登录入口置灰，本地可继续使用', async () => {
    env.transport.failNetwork = true;
    renderLogin();
    fireEvent.change(screen.getByLabelText('登录邮箱'), { target: { value: 'dev@example.com' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'Abcd1234' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('status')).toBeTruthy();
    await waitFor(() => expect(env.offline.isOffline()).toBe(true));
    expect((await screen.findAllByText(/当前离线，本地功能可用/)).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('登录邮箱')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'GitHub 登录' })).toBeDisabled();
  });

  it('恢复探测成功后横幅消失', async () => {
    env.transport.failNetwork = true;
    renderLogin();
    fireEvent.change(screen.getByLabelText('登录邮箱'), { target: { value: 'a@b.com' } });
    fireEvent.change(screen.getByLabelText('登录密码'), { target: { value: 'Abcd1234' } });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));
    await waitFor(() => expect(env.offline.isOffline()).toBe(true));

    env.transport.failNetwork = false;
    fireEvent.click(screen.getByRole('button', { name: '重试连接' }));
    await waitFor(() => expect(env.offline.isOffline()).toBe(false));
    await waitFor(() => expect(screen.queryAllByText(/当前离线，本地功能可用/)).toHaveLength(0));
  });
});

describe('绑定与解绑（FR-ACC-06）', () => {
  const identity = {
    accountId: 'acc-1',
    login: 'dev@example.com',
    displayName: '小吴',
    avatarUrl: null,
    emailVerified: false,
    hasPassword: false,
  };

  it('仅剩单一第三方方式且未设密码时解绑被拒并提示先设置密码（不发请求）', async () => {
    await signIn();
    env.transport.bindings = [{ provider: 'github', externalId: 'octocat', boundAt: 1 }];
    render(
      <AuthApiProvider api={env.api}>
        <BindingPanel identity={identity} />
      </AuthApiProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: '解绑' }));
    expect(await screen.findByText(/请先设置密码再解绑/)).toBeTruthy();
    expect(env.transport.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('已设置密码时可解绑成功', async () => {
    await signIn();
    env.transport.bindings = [{ provider: 'github', externalId: 'octocat', boundAt: 1 }];
    render(
      <AuthApiProvider api={env.api}>
        <BindingPanel identity={{ ...identity, hasPassword: true }} />
      </AuthApiProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '解绑' }));
    await waitFor(() =>
      expect(env.transport.calls.some((call) => call.method === 'DELETE')).toBe(true),
    );
    expect(await screen.findByText(/GitHub 已解绑/)).toBeTruthy();
  });

  it('列出四种登录方式的绑定状态，未绑定的可绑定', async () => {
    await signIn();
    render(
      <AuthApiProvider api={env.api}>
        <BindingPanel identity={{ ...identity, hasPassword: true }} />
      </AuthApiProvider>,
    );
    await screen.findByText('GitHub');
    expect(screen.getAllByText('未绑定').length).toBe(3);
    fireEvent.click(screen.getAllByRole('button', { name: '绑定' })[0]!);
    await waitFor(() =>
      expect(
        env.transport.calls.some(
          (call) => call.method === 'POST' && call.url.includes('/bindings'),
        ),
      ).toBe(true),
    );
  });
});

describe('账号中心页面', () => {
  it('未登录展示登录页；登录后展示账号中心并可退出', async () => {
    render(<AuthPage api={env.api} />);
    expect(await screen.findByRole('form', { name: '登录' })).toBeTruthy();

    // 先建立本地会话，再重新挂载页面模拟"重启后恢复"
    await env.api.login({ email: 'dev@example.com', password: 'Abcd1234', rememberMe: true });
    const restored = await env.api.restore();
    expect(restored).not.toBeNull();

    render(<AuthPage api={env.api} />);
    expect((await screen.findAllByText('账号中心')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: '退出登录' })[0]!);
    await waitFor(() => expect(env.secure.map.size).toBe(0));
  });

  it('未注入端口时展示装配引导而不是崩溃', () => {
    render(<AuthPage api={null} />);
    expect(screen.getByText(/账号服务尚未连接/)).toBeTruthy();
  });
});
