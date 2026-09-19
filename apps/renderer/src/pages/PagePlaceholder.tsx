import { EmptyState } from '@ec/ui';

/** 占位页通用骨架：标题 + 描述 + 空状态 */
export function PagePlaceholder({
  title,
  description,
}: {
  title: string;
  description: string;
}): JSX.Element {
  return (
    <section className="ec-page" aria-label={title}>
      <h1 className="ec-page__title">{title}</h1>
      <p className="ec-page__desc">{description}</p>
      <EmptyState
        title="该模块尚未实现"
        description="对应 Wave 任务完成后，此页面将提供完整功能。"
      />
    </section>
  );
}
