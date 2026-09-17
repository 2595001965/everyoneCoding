/// <reference types="react" />

/** Vite 特殊导入的模块声明（?raw 等） */
declare module '*.css?raw' {
  const content: string;
  export default content;
}
