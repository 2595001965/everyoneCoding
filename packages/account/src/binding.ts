/**
 * 绑定与解绑规则（T9-05 / FR-ACC-06）。
 *
 * 规则：一个主账号可绑定多个第三方身份；**解绑时若仅剩单一登录方式且未设置密码，
 * 必须先设置密码**——否则用户会被永久锁在账号外。
 */

import type { AuthProvider, Binding } from './auth-types';

export interface UnbindCheck {
  allowed: boolean;
  /** 是否必须先设置密码才能解绑 */
  requiresPassword: boolean;
  /** 不允许时的中文原因 */
  reason: string | null;
}

/** 校验某第三方身份能否解绑 */
export function canUnbind(input: {
  bindings: Binding[];
  target: AuthProvider;
  hasPassword: boolean;
}): UnbindCheck {
  const exists = input.bindings.some((binding) => binding.provider === input.target);
  if (!exists) {
    return { allowed: false, requiresPassword: false, reason: '该登录方式尚未绑定，无需解绑。' };
  }
  const remaining = input.bindings.filter((binding) => binding.provider !== input.target);
  if (remaining.length === 0 && !input.hasPassword) {
    return {
      allowed: false,
      requiresPassword: true,
      reason: '这是当前唯一的登录方式且未设置密码，请先设置密码再解绑，否则将无法登录。',
    };
  }
  return { allowed: true, requiresPassword: false, reason: null };
}

/** 绑定前校验：已绑定则不允许重复绑定 */
export function canBind(bindings: Binding[], target: AuthProvider): { allowed: boolean; reason: string | null } {
  if (bindings.some((binding) => binding.provider === target)) {
    return { allowed: false, reason: '该登录方式已绑定到当前账号。' };
  }
  return { allowed: true, reason: null };
}

/** 可用于登录的方式清单（登录页展示"还可使用"提示） */
export function availableLoginMethods(bindings: Binding[], hasPassword: boolean, email: string): AuthProvider[] {
  const methods: AuthProvider[] = [];
  if (hasPassword) methods.push('email');
  for (const binding of bindings) methods.push(binding.provider);
  void email;
  return methods;
}
