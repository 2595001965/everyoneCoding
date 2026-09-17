import { describe, expect, it } from 'vitest';

import { pinyinTableSize, segmentWords, toIdentifier, toPinyin, uniqueIdentifier } from '../identifier';

describe('T3-01 标识符投影（D-10）', () => {
  it('中文显示名转 camelCase 标识符', () => {
    expect(toIdentifier('登录页')).toBe('dengLuYe');
    expect(toIdentifier('提交按钮')).toBe('tiJiaoAnNiu');
    expect(toIdentifier('手机号输入框')).toBe('shouJiHaoShuRuKuang');
  });

  it('支持 pascal / kebab / snake / constant 风格', () => {
    expect(toIdentifier('登录页', { style: 'pascal' })).toBe('DengLuYe');
    expect(toIdentifier('提交按钮', { style: 'kebab' })).toBe('ti-jiao-an-niu');
    expect(toIdentifier('提交按钮', { style: 'snake' })).toBe('ti_jiao_an_niu');
    expect(toIdentifier('用户列表', { style: 'constant' })).toBe('YONG_HU_LIE_BIAO');
  });

  it('拉丁词与中文混排时保持词界', () => {
    expect(toIdentifier('userName')).toBe('userName');
    expect(toIdentifier('userName', { style: 'constant' })).toBe('USER_NAME');
    expect(toIdentifier('user 登录 页')).toBe('userDengLuYe');
    expect(toIdentifier('my-button')).toBe('myButton');
  });

  it('未收录汉字按 Unicode 码点降级，可选丢弃', () => {
    const rare = '龘';
    expect(toIdentifier(rare)).toBe(`u${rare.codePointAt(0)?.toString(16)}`);
    expect(toIdentifier(rare, { unknown: 'drop' })).toBe('el');
    expect(toIdentifier(rare, { unknown: 'drop', fallback: 'box' })).toBe('box');
  });

  it('自定义映射表优先于内置表', () => {
    expect(toIdentifier('数据域', { dictionary: { 域: 'zone' } })).toBe('shuJuZone');
  });

  it('空输入可回退原文或兜底值', () => {
    expect(toIdentifier('', { preserveOriginal: true })).toBe('el');
    expect(toIdentifier('!!!', { preserveOriginal: true })).toBe('el');
    expect(toIdentifier('a!!!b', { preserveOriginal: true })).toBe('aB');
  });

  it('标识符不以数字开头', () => {
    expect(toIdentifier('2fa')).toBe('_2fa');
  });

  it('uniqueIdentifier 追加序号去重', () => {
    expect(uniqueIdentifier('login', [])).toBe('login');
    expect(uniqueIdentifier('login', ['login'])).toBe('login_2');
    expect(uniqueIdentifier('login', ['login', 'login_2'])).toBe('login_3');
  });

  it('segmentWords / toPinyin 提供可读拼音串', () => {
    expect(segmentWords('用户列表')).toEqual(['yong', 'hu', 'lie', 'biao']);
    expect(toPinyin('用户列表')).toBe('yong hu lie biao');
  });

  it('内置拼音表覆盖常用 UI 汉字（规模断言，防止表被误删）', () => {
    expect(pinyinTableSize()).toBeGreaterThan(200);
  });
});
