import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { AuthPage } from '../index';
import { AuthApiProvider } from '../auth-api';
import { BindingPanel } from '../BindingPanel';
import { EmailVerificationPanel } from '../EmailVerificationPanel';
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

/**
 * 第三方登录必须是**闭环**：只 `beginOAuth` 打开浏览器不算登录成功。
 * 之前的断点正是这里——浏览器里授权成功了，应用侧永远不知道自己已登录。
 */
describe('第三方登录闭环（FR-ACC-02/03）', () => {
  it('Google/GitHub 登录：发起后等待回调，浏览器命中回环即完成登录', async () => {
    const { onAuthenticated } = renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'GitHub 登录' }));

    // 等待期间给出可读提示（用户知道要去浏览器），并且不会重复发起
    expect(await screen.findByText(/请在浏览器中完成/)).toBeTruthy();
    expect(env.system.opened).toHaveLength(1);

    // 模拟"用户在浏览器里完成授权后命中本地回环"
    await waitFor(() => expect(env.system.handler).not.toBeNull());
    env.system.handler!('http://127.0.0.1:49152/oauth/callback?code=gh-code&state=srv-state-test');

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled());
    const session = onAuthenticated.mock.calls[0]![0] as { identity: { accountId: string } };
    expect(session.identity.accountId).toBe('acc-1');
    // 完成后等待提示消失
    await waitFor(() => expect(screen.queryByText(/请在浏览器中完成/)).toBeNull());
  });

  it('等待期间可取消：取消后不再显示等待态，也不再重复轮询', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: 'Google 登录' }));
    expect(await screen.findByText(/请在浏览器中完成/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '取消等待' }));
    await waitFor(() => expect(screen.queryByText(/请在浏览器中完成/)).toBeNull());
  });

  it('微信扫码确认后直接完成登录（回调 URL 由状态轮询带回，无需回环/协议）', async () => {
    const { onAuthenticated } = renderLogin();
    fireEvent.click(screen.getByRole('button', { name: '微信扫码' }));
    expect(await screen.findByLabelText('微信扫码登录')).toBeTruthy();

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalled(), { timeout: 8000 });
    expect(env.transport.calls.some((call) => call.url.includes('/oauth/wechat/callback'))).toBe(
      true,
    );
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
    env.transport.bindings = [
      { id: 'b-gh', provider: 'github', externalId: 'octocat', boundAt: 1 },
    ];
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
    env.transport.bindings = [
      { id: 'b-gh', provider: 'github', externalId: 'octocat', boundAt: 1 },
    ];
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

    // 绑定走真实 OAuth：点下按钮后 AuthClient 会打开浏览器并**阻塞等待回环回调**。
    // 测试模拟"浏览器完成授权后命中 127.0.0.1 回环"，这才算走完绑定全程。
    await waitFor(() => expect(env.system.handler).not.toBeNull());
    env.system.handler!('http://127.0.0.1:49152/oauth/callback?code=gh-code&state=srv-state-test');

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

/**
 * 找回密码（FR-ACC-08）。
 *
 * 关键断言是"**真的发了服务端请求**"：只看界面从 step1 跳到 step2 是测不出
 * 请求被漏发/发错端点的（那正是"点了发送但收不到邮件"的典型故障形态）。
 */
describe('找回密码（FR-ACC-08）', () => {
  it('登录页可进入找回密码：邮箱非法时发送按钮禁用', () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: '忘记密码？' }));
    expect(screen.getByRole('form', { name: '找回密码' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('找回密码邮箱'), { target: { value: 'not-an-email' } });
    expect(screen.getByRole('button', { name: '发送验证码' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('找回密码邮箱'), {
      target: { value: 'dev@example.com' },
    });
    expect(screen.getByRole('button', { name: '发送验证码' })).not.toBeDisabled();
  });

  it('请求验证码：真的打到 /password/reset/request，进入第二步并启动冷却倒计时', async () => {
    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: '忘记密码？' }));
    fireEvent.change(screen.getByLabelText('找回密码邮箱'), {
      target: { value: 'dev@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));

    await waitFor(() => expect(screen.getByRole('form', { name: '重置密码' })).toBeTruthy());
    expect(env.transport.resetRequests).toEqual(['dev@example.com']);
    // 不泄露注册状态：未注册邮箱同样提示"若已注册则已发送"
    expect(screen.getByText(/若该邮箱已注册/)).toBeTruthy();
    // 冷却中：重发按钮置灰，避免用户只能靠 429 才发现"还要等"
    expect(screen.getByRole('button', { name: /重新发送（\d+s）/ })).toBeDisabled();
  });

  it('重置密码：验证码 + 新密码提交到 /password/reset，并回调 onReset（回登录页）', async () => {
    render(
      <AuthApiProvider api={env.api}>
        <LoginPage onAuthenticated={vi.fn()} />
      </AuthApiProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: '找回密码' }));
    fireEvent.change(screen.getByLabelText('找回密码邮箱'), {
      target: { value: 'dev@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    await waitFor(() => expect(screen.getByRole('form', { name: '重置密码' })).toBeTruthy());

    // 新密码强度不足时不可提交
    fireEvent.change(screen.getByLabelText('重置验证码'), { target: { value: '123456' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: '123' } });
    expect(screen.getByRole('button', { name: '重置密码' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'Abcd1234!xyz' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'Abcd1234!xyz' } });
    const submit = screen.getByRole('button', { name: '重置密码' });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() =>
      expect(
        env.transport.calls.some(
          (call) => call.method === 'POST' && call.url.endsWith('/api/auth/password/reset'),
        ),
      ).toBe(true),
    );
    // 回登录页并给出"请用新密码登录"的提示
    await waitFor(() => expect(screen.getByRole('form', { name: '登录' })).toBeTruthy());
    expect(screen.getByText(/密码已重置/)).toBeTruthy();
    // 登录邮箱被回填，用户只需输入新密码（少一步手输）
    expect((screen.getByLabelText('登录邮箱') as HTMLInputElement).value).toBe('dev@example.com');
  });

  it('服务端拒绝（验证码过期/已用）时原样透传文案，不假装成功', async () => {
    env.transport.failNetwork = false;
    const originalRequest = env.transport.request.bind(env.transport);
    env.transport.request = async (input) => {
      if (input.url.endsWith('/api/auth/password/reset')) {
        return {
          status: 400,
          json: { error: 'bad_request', message: '验证码无效、已过期或已被使用，请重新获取重置码' },
        };
      }
      return originalRequest(input);
    };

    renderLogin();
    fireEvent.click(screen.getByRole('button', { name: '忘记密码？' }));
    fireEvent.change(screen.getByLabelText('找回密码邮箱'), {
      target: { value: 'dev@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    await waitFor(() => expect(screen.getByRole('form', { name: '重置密码' })).toBeTruthy());

    fireEvent.change(screen.getByLabelText('重置验证码'), { target: { value: '000000' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'Abcd1234!xyz' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'Abcd1234!xyz' } });
    fireEvent.click(screen.getByRole('button', { name: '重置密码' }));

    expect(await screen.findByText(/验证码无效、已过期或已被使用/)).toBeTruthy();
    // 关键：失败后**没有**回到登录页（不能假装重置成功）
    expect(screen.getByRole('form', { name: '重置密码' })).toBeTruthy();
  });
});

/**
 * 邮箱验证状态面板（FR-ACC-08）。
 *
 * 状态**必须查服务端**：验证链接在系统浏览器里点开，桌面端拿不到信号，
 * 会话里的 `emailVerified` 只是登录那一刻的快照。
 */
describe('邮箱验证状态（FR-ACC-08）', () => {
  const identity = {
    accountId: 'acc-1',
    login: 'dev@example.com',
    displayName: '小吴',
    avatarUrl: null,
    emailVerified: false,
    hasPassword: true,
  };

  function renderPanel(sessionIdentity = identity) {
    render(
      <AuthApiProvider api={env.api}>
        <EmailVerificationPanel identity={sessionIdentity} />
      </AuthApiProvider>,
    );
  }

  it('挂载即查服务端：外部浏览器完成验证后，刷新状态翻转为已验证', async () => {
    renderPanel();
    expect(await screen.findByText('未验证')).toBeTruthy();

    // 模拟"用户刚在浏览器里点完了验证链接"
    env.transport.serverEmailVerified = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新验证状态' }));

    expect(await screen.findByText('已验证')).toBeTruthy();
    expect(env.transport.calls.some((call) => call.url.includes('/api/auth/email/status'))).toBe(
      true,
    );
  });

  it('重发验证邮件：真的打到 /email/verify 并进入冷却；已验证则不再展示重发入口', async () => {
    renderPanel();
    await screen.findByText('未验证');

    fireEvent.click(screen.getByRole('button', { name: '重新发送验证邮件' }));
    await waitFor(() =>
      expect(
        env.transport.calls.some(
          (call) => call.method === 'POST' && call.url.endsWith('/api/auth/email/verify'),
        ),
      ).toBe(true),
    );
    expect(screen.getByRole('button', { name: /重新发送（\d+s）/ })).toBeDisabled();

    // 已登录且服务端已标记验证：不展示重发/刷新入口
    cleanup();
    env.transport.serverEmailVerified = true;
    renderPanel({ ...identity, emailVerified: true });
    expect(await screen.findByText('已验证')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /重新发送/ })).toBeNull();
  });
});
