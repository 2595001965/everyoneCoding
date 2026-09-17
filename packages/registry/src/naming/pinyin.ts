/**
 * 中文 → 拼音（T7-01 要点 3，D-10 的兜底路径）。
 *
 * 轻量自持实现，不引第三方拼音库（与 `@ec/designer` 的 `dsl/identifier.ts` 同源策略）：
 * - 内置 UI 命名高频汉字单音节表，未收录字按 Unicode 码点降级（`u4e2d`）；
 * - 支持项目自定义映射表（优先级最高，覆盖英文术语表与拼音表）；
 * - 三种解析模式：`english`（默认，英文术语优先）/ `pinyin`（强制拼音）/ `preserve`（保留原文）。
 *
 * ⚠️ 与 `@ec/designer` 的 `dsl/identifier.ts` 存在一张**同名拼音表**：设计器包为
 * 浏览器 UI 包（依赖 React / dnd-kit），注册表作为更底层的领域包不应反向依赖它，
 * 故此处自持一份。两表内容一致，新增字时应同步（见 `packages/designer/src/dsl/identifier.ts`）。
 */

/** UI 命名高频汉字拼音表（单音节，无音调） */
export const PINYIN: Readonly<Record<string, string>> = {
  /* 账户与登录 */
  登: 'deng', 录: 'lu', 注: 'zhu', 册: 'ce', 用: 'yong', 户: 'hu', 名: 'ming', 称: 'cheng',
  密: 'mi', 码: 'ma', 手: 'shou', 机: 'ji', 邮: 'you', 箱: 'xiang', 验: 'yan', 证: 'zheng',
  账: 'zhang', 号: 'hao', 找: 'zhao', 头: 'tou', 像: 'xiang', 绑: 'bang', 解: 'jie',
  /* 页面与导航 */
  首: 'shou', 页: 'ye', 面: 'mian', 导: 'dao', 航: 'hang', 菜: 'cai', 单: 'dan', 标: 'biao',
  签: 'qian', 链: 'lian', 接: 'jie', 跳: 'tiao', 转: 'zhuan', 路: 'lu', 由: 'you', 参: 'can',
  数: 'shu', 图: 'tu', 子: 'zi', 父: 'fu', 级: 'ji', 层: 'ceng', 树: 'shu', 收: 'shou',
  起: 'qi', 展: 'zhan', 开: 'kai', 折: 'zhe', 叠: 'die',
  /* 布局容器 */
  容: 'rong', 器: 'qi', 布: 'bu', 局: 'ju', 行: 'hang', 列: 'lie', 网: 'wang', 格: 'ge',
  卡: 'ka', 片: 'pian', 板: 'ban', 抽: 'chou', 屉: 'ti', 分: 'fen', 隔: 'ge', 区: 'qu',
  块: 'kuai', 栏: 'lan', 边: 'bian', 距: 'ju', 内: 'nei', 外: 'wai', 宽: 'kuan', 高: 'gao',
  度: 'du', 对: 'dui', 齐: 'qi', 中: 'zhong', 心: 'xin', 左: 'zuo', 右: 'you', 上: 'shang',
  下: 'xia', 顶: 'ding', 部: 'bu', 底: 'di', 侧: 'ce', 位: 'wei', 置: 'zhi', 绝: 'jue',
  流: 'liu', 式: 'shi', 自: 'zi', 适: 'shi',
  /* 基础控件 */
  文: 'wen', 本: 'ben', 按: 'an', 钮: 'niu', 输: 'shu', 入: 'ru', 框: 'kuang', 选: 'xuan',
  择: 'ze', 表: 'biao', 项: 'xiang', 复: 'fu', 滑: 'hua', 进: 'jin', 条: 'tiao', 加: 'jia',
  载: 'zai', 提: 'ti', 示: 'shi', 徽: 'hui', 章: 'zhang', 步: 'bu', 骤: 'zhou', 包: 'bao',
  /* 数据展示 */
  排: 'pai', 序: 'xu', 筛: 'shai', 查: 'cha', 询: 'xun', 搜: 'sou', 索: 'suo', 过: 'guo',
  滤: 'lv', 总: 'zong', 计: 'ji', 统: 'tong', 报: 'bao', 仪: 'yi', 盘: 'pan', 看: 'kan',
  柱: 'zhu', 饼: 'bing', 趋: 'qu', 势: 'shi',
  /* 业务名词 */
  商: 'shang', 品: 'pin', 订: 'ding', 购: 'gou', 物: 'wu', 车: 'che', 类: 'lei', 价: 'jia',
  库: 'ku', 存: 'cun', 销: 'xiao', 售: 'shou', 描: 'miao', 述: 'shu', 详: 'xiang', 情: 'qing',
  状: 'zhuang', 态: 'tai', 时: 'shi', 间: 'jian', 日: 'ri', 期: 'qi', 创: 'chuang', 建: 'jian',
  更: 'geng', 新: 'xin', 删: 'shan', 除: 'chu', 编: 'bian', 辑: 'ji', 增: 'zeng', 保: 'bao',
  交: 'jiao', 取: 'qu', 消: 'xiao', 确: 'que', 认: 'ren', 返: 'fan', 制: 'zhi', 移: 'yi',
  动: 'dong', 拖: 'tuo', 拽: 'zhuai', 缩: 'suo', 放: 'fang', 平: 'ping', 旋: 'xuan', 隐: 'yin',
  藏: 'cang', 锁: 'suo', 显: 'xian', 醒: 'xing', 目: 'mu', 模: 'mo', 窗: 'chuang', 口: 'kou',
  通: 'tong', 知: 'zhi', 错: 'cuo', 误: 'wu', 警: 'jing', 告: 'gao', 成: 'cheng', 功: 'gong',
  失: 'shi', 败: 'bai', 我: 'wo', 们: 'men', 你: 'ni', 的: 'de', 全: 'quan', 旧: 'jiu',
  属: 'shu', 性: 'xing', 事: 'shi', 件: 'jian', 作: 'zuo', 请: 'qing', 求: 'qiu', 赋: 'fu',
  值: 'zhi', 渲: 'xuan', 染: 'ran', 角: 'jiao', 色: 'se', 版: 'ban', 母: 'mu', 例: 'li',
  实: 'shi', 现: 'xian', 象: 'xiang', 段: 'duan', 点: 'dian', 历: 'li', 史: 'shi', 快: 'kuai',
  照: 'zhao', 滚: 'gun', 无: 'wu', 空: 'kong', 默: 'mo', 权: 'quan', 限: 'xian', 回: 'hui',
  退: 'tui', 定: 'ding', 据: 'ju', 弹: 'dan',
};

/** 拼音表规模（测试与文档断言用） */
export function pinyinTableSize(): number {
  return Object.keys(PINYIN).length;
}

/** 单字拼音（无音调）；未收录返回 null */
export function pinyinOf(char: string, dictionary?: Readonly<Record<string, string>>): string | null {
  const custom = dictionary?.[char];
  if (custom !== undefined && custom.length > 0) return custom;
  const builtin = PINYIN[char];
  return builtin ?? null;
}

/** 中文 → 空格分隔拼音串（人工可读，用于展示与降级） */
export function toPinyin(
  text: string,
  options: { dictionary?: Readonly<Record<string, string>>; unknown?: 'unicode' | 'drop' } = {},
): string {
  const unknown = options.unknown ?? 'unicode';
  const words: string[] = [];
  for (const char of text) {
    if (!isCjk(char)) continue;
    const word = pinyinOf(char, options.dictionary);
    if (word !== null) {
      words.push(word);
      continue;
    }
    if (unknown === 'unicode') words.push(unicodeFallback(char));
  }
  return words.join(' ');
}

/** CJK 统一表意文字判定 */
export function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

/** 未收录汉字的 Unicode 降级形式：`u` + 十六进制码点 */
export function unicodeFallback(char: string): string {
  return `u${(char.codePointAt(0) ?? 0).toString(16)}`;
}
