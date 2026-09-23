/**
 * 邮箱验证落地页（邮件链接指向这里）。
 *
 * ## 为什么由账号服务自己托管，而不是渲染层页面
 *
 * 用户是在**邮件客户端 / 系统浏览器**里点验证链接的，此时桌面应用很可能没有运行。
 * 若链接指向渲染层：
 * - 桌面端关闭 ⇒ 链接 404，用户看到的是"服务不可用"，验证根本无法完成；
 * - 渲染层用 HashRouter，`http://host/verify-email?token=…` 这种裸路径路由不到任何页面
 *   （必须是 `#/verify-email`，而邮件正文里带 `#` 极易被客户端截断）。
 *
 * 由服务自己托管后，这条链路**不依赖任何客户端**：链接 → 页面 → 调用本服务的
 * confirm 接口 → 结果就地呈现。桌面端下次启动时用 `emailVerified(email)` 轮询即知结果。
 *
 * ## 安全
 *
 * 页面是**完全静态**的：token 只出现在地址栏，由页面脚本自己从 `location.search` 读取，
 * **不做任何服务端字符串插值** —— 于是不存在把 query 参数注入 HTML 的可能（XSS 免谈）。
 */

import type { FastifyInstance } from 'fastify';

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>邮箱验证 · EveryoneCoding</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #f6f7f9; color: #1f2328;
  }
  .card {
    width: min(420px, calc(100vw - 32px)); padding: 28px; border-radius: 12px;
    background: #fff; border: 1px solid #e5e7eb; box-shadow: 0 1px 3px rgba(0,0,0,.06);
    text-align: center;
  }
  h1 { font-size: 18px; margin: 0 0 12px; }
  p { margin: 0; font-size: 14px; line-height: 1.6; color: #57606a; }
  .mark { font-size: 34px; line-height: 1; margin-bottom: 12px; }
  .ok .mark { color: #1f8b4c; }
  .fail .mark { color: #c0392b; }
  .detail { margin-top: 12px; font-size: 13px; color: #6b7280; word-break: break-word; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181d; color: #e6e8eb; }
    .card { background: #1e2128; border-color: #2f343d; }
    p { color: #a7adb8; }
    .detail { color: #8b939f; }
  }
</style>
</head>
<body>
  <main class="card" id="card">
    <div class="mark" aria-hidden="true">⏳</div>
    <h1 id="title">正在验证邮箱…</h1>
    <p id="desc">请稍候，正在与账号服务确认验证令牌。</p>
    <p class="detail" id="detail"></p>
  </main>
  <script>
    (function () {
      var params = new URLSearchParams(location.search);
      var token = params.get('token') || '';
      var card = document.getElementById('card');
      var title = document.getElementById('title');
      var desc = document.getElementById('desc');
      var detail = document.getElementById('detail');

      function fail(message) {
        card.className = 'card fail';
        card.querySelector('.mark').textContent = '\\u2715';
        title.textContent = '验证未完成';
        desc.textContent = message;
        detail.textContent = '请在 EveryoneCoding 客户端重新发送验证邮件后重试。';
      }

      if (!token) {
        fail('验证链接缺少令牌。');
        return;
      }

      fetch('/api/auth/email/verify/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token })
      })
        .then(function (response) {
          return response.json().catch(function () { return {}; }).then(function (body) {
            return { status: response.status, body: body };
          });
        })
        .then(function (result) {
          if (result.status >= 200 && result.status < 300 && result.body && result.body.ok) {
            card.className = 'card ok';
            card.querySelector('.mark').textContent = '\\u2713';
            title.textContent = '邮箱验证完成';
            desc.textContent = '可以回到 EveryoneCoding 客户端继续使用了。';
            detail.textContent = '';
            return;
          }
          fail((result.body && (result.body.message || result.body.error)) || '验证令牌无效或已过期。');
        })
        .catch(function () {
          fail('无法连接账号服务，请确认客户端或服务端已启动。');
        });
    })();
  </script>
</body>
</html>
`;

/**
 * 注册 `GET /verify-email`。
 *
 * 只做一件事：把静态页面吐给浏览器。真正的验证走 `POST /api/auth/email/verify/confirm`，
 * 两者共用同一套令牌校验（单次有效 + 过期拒绝），页面本身不持有任何校验逻辑。
 */
export async function verifyPageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/verify-email', async (_req, reply) => {
    // charset 必须显式声明：页面含中文，缺了它浏览器按 latin-1 解会出现乱码
    // 令牌在地址栏里，禁止缓存这份页面，避免共享终端上留下可复用页面
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(PAGE);
  });
}
