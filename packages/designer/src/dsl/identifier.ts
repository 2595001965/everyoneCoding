/**
 * 标识符投影（D-10）：中文显示名 → 英文 / 拼音标识符（T3-01 要点 2）。
 *
 * 采用**轻量自持实现**，不引第三方拼音库：
 * - 内置一份面向 UI 命名的常用汉字拼音表（单音节），未收录的字按 Unicode 码点降级；
 * - 可通过 `dictionary` 传入自定义映射表（项目级术语表），优先级高于内置表；
 * - 大小写风格可配置（camel / pascal / kebab / snake / constant）；
 * - `preserveOriginal` 打开时，若整串无法转换则原样保留（仅做安全字符裁剪）。
 *
 * 该函数是纯函数，供设计器、重命名引擎（Wave 7）与代码生成共同使用。
 */

export type IdentifierStyle = 'camel' | 'pascal' | 'kebab' | 'snake' | 'constant';

export interface ToIdentifierOptions {
  style?: IdentifierStyle;
  /** 自定义映射表：汉字 → 拼音（无音调，小写） */
  dictionary?: Readonly<Record<string, string>>;
  /** 未收录汉字的降级策略：unicode = u5b57 形式；drop = 丢弃 */
  unknown?: 'unicode' | 'drop';
  /** 无法转换且结果为空时，是否回退为原文（仅保留合法字符） */
  preserveOriginal?: boolean;
  /** 结果为空时的兜底值，默认 'el' */
  fallback?: string;
}

/** UI 命名高频汉字拼音表（覆盖组件名 / 页面名 / 业务名词；每字单音节） */
const PINYIN: Readonly<Record<string, string>> = {
  // 账户与登录
  登: 'deng', 录: 'lu', 注: 'zhu', 册: 'ce', 用: 'yong', 户: 'hu', 名: 'ming', 称: 'cheng',
  密: 'mi', 码: 'ma', 手: 'shou', 机: 'ji', 邮: 'you', 箱: 'xiang', 验: 'yan', 证: 'zheng',
  账: 'zhang', 号: 'hao', 找: 'zhao', 头: 'tou', 像: 'xiang', 绑: 'bang', 解: 'jie',
  // 页面与导航
  首: 'shou', 页: 'ye', 面: 'mian', 导: 'dao', 航: 'hang', 菜: 'cai', 单: 'dan', 标: 'biao',
  签: 'qian', 链: 'lian', 接: 'jie', 跳: 'tiao', 转: 'zhuan', 路: 'lu', 由: 'you', 参: 'can',
  数: 'shu', 图: 'tu', 子: 'zi', 父: 'fu', 级: 'ji', 层: 'ceng', 树: 'shu', 收: 'shou',
  起: 'qi', 展: 'zhan', 开: 'kai', 折: 'zhe', 叠: 'die',
  // 布局容器
  容: 'rong', 器: 'qi', 布: 'bu', 局: 'ju', 行: 'hang', 列: 'lie', 网: 'wang', 格: 'ge',
  卡: 'ka', 片: 'pian', 板: 'ban', 抽: 'chou', 屉: 'ti', 分: 'fen', 隔: 'ge', 区: 'qu',
  块: 'kuai', 栏: 'lan', 边: 'bian', 距: 'ju', 内: 'nei', 外: 'wai', 宽: 'kuan', 高: 'gao',
  度: 'du', 对: 'dui', 齐: 'qi', 中: 'zhong', 心: 'xin', 左: 'zuo', 右: 'you', 上: 'shang',
  下: 'xia', 顶: 'ding', 部: 'bu', 底: 'di', 侧: 'ce', 位: 'wei', 置: 'zhi', 绝: 'jue',
  流: 'liu', 式: 'shi', 自: 'zi', 适: 'shi',
  // 基础控件
  文: 'wen', 本: 'ben', 按: 'an', 钮: 'niu', 输: 'shu', 入: 'ru', 框: 'kuang', 选: 'xuan',
  择: 'ze', 表: 'biao', 项: 'xiang', 复: 'fu', 滑: 'hua', 进: 'jin', 条: 'tiao', 加: 'jia',
  载: 'zai', 提: 'ti', 示: 'shi', 徽: 'hui', 章: 'zhang', 步: 'bu', 骤: 'zhou', 包: 'bao',
  // 数据展示
  排: 'pai', 序: 'xu', 筛: 'shai', 查: 'cha', 询: 'xun', 搜: 'sou', 索: 'suo', 过: 'guo',
  滤: 'lv', 总: 'zong', 计: 'ji', 统: 'tong', 报: 'bao', 仪: 'yi', 盘: 'pan', 看: 'kan',
  柱: 'zhu', 饼: 'bing', 趋: 'qu', 势: 'shi',
  // 业务名词
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

/** 视为分隔符的字符（不产出 token） */
const SEPARATOR = /[\s\-_./:\\|,+，。、；;（）()【】[\]{}]+/;
/** 单字符词法：[A-Za-z0-9] 归拉丁串，中日韩统一表意文字归拼音 */
const LATIN_CHAR = /[A-Za-z0-9]/;
const CJK_CHAR = /[\u4e00-\u9fff\u3400-\u4dbf]/;

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1);
}

/** 把任意显示名切分为词序列（拉丁词保持原形，汉字逐字转拼音） */
export function segmentWords(input: string, options: ToIdentifierOptions = {}): string[] {
  const dictionary = options.dictionary ?? {};
  const unknownMode = options.unknown ?? 'unicode';
  const words: string[] = [];
  let latin = '';

  const flushLatin = (): void => {
    if (latin.length === 0) return;
    for (const part of splitCamelRun(latin)) words.push(part);
    latin = '';
  };

  for (const char of input) {
    if (LATIN_CHAR.test(char)) {
      latin += char;
      continue;
    }
    flushLatin();
    if (SEPARATOR.test(char)) continue;
    const custom = dictionary[char];
    if (custom !== undefined && custom.length > 0) {
      words.push(custom);
      continue;
    }
    const builtin = PINYIN[char];
    if (builtin !== undefined) {
      words.push(builtin);
      continue;
    }
    if (CJK_CHAR.test(char)) {
      if (unknownMode === 'unicode') words.push(`u${char.codePointAt(0)?.toString(16) ?? ''}`);
    }
    // 其他字符（表情、全角标点等）丢弃
  }
  flushLatin();
  return words;
}

/**
 * 拆开驼峰拉丁串，保证 `userName` / `APIKey` 这类输入在转成 snake/kebab 时词界正确：
 * `userName → ['user','Name']`、`APIKey → ['API','Key']`。
 */
function splitCamelRun(run: string): string[] {
  return run.match(/[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g) ?? [];
}

function applyStyle(words: readonly string[], style: IdentifierStyle): string {
  const lowered = words.map((word) => word.toLowerCase());
  switch (style) {
    case 'pascal':
      return lowered.map(capitalize).join('');
    case 'kebab':
      return lowered.join('-');
    case 'snake':
      return lowered.join('_');
    case 'constant':
      return lowered.join('_').toUpperCase();
    default:
      return lowered.map((word, index) => (index === 0 ? word : capitalize(word))).join('');
  }
}

/**
 * 生成标识符。
 *
 * @example
 * toIdentifier('登录页')                        // 'dengLuYe'
 * toIdentifier('登录页', { style: 'pascal' })    // 'DengLuYe'
 * toIdentifier('提交按钮', { style: 'kebab' })   // 'ti-jiao-an-niu'
 * toIdentifier('userName', { style: 'constant' }) // 'USER_NAME'
 */
export function toIdentifier(input: string, options: ToIdentifierOptions = {}): string {
  const style = options.style ?? 'camel';
  const fallback = options.fallback ?? 'el';
  const words = segmentWords(input, options);
  let result = applyStyle(words, style);
  if (result.length === 0) {
    if (options.preserveOriginal === true) {
      const cleaned = input.replace(/[^A-Za-z0-9_-]/g, '');
      result = cleaned.length > 0 ? cleaned : fallback;
    } else {
      result = fallback;
    }
  }
  // 标识符不得以数字开头
  if (/^[0-9]/.test(result)) result = `_${result}`;
  return result;
}

/** 在已有集合内生成不冲突的标识符（追加 _2 / _3 …） */
export function uniqueIdentifier(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

/** 中文 → 拼音串（词间以空格分隔，便于人工可读；未收录字按 unicode 降级） */
export function toPinyin(text: string, options: ToIdentifierOptions = {}): string {
  return segmentWords(text, { ...options, unknown: options.unknown ?? 'unicode' }).join(' ');
}

/** 暴露内置表条目数，便于测试与文档断言覆盖规模 */
export function pinyinTableSize(): number {
  return Object.keys(PINYIN).length;
}
