/**
 * Playground：组件自检页面。逐区块渲染全部组件，供 renderer dev 模式挂载。
 * 不引入任何额外依赖；所有交互均为本地受控状态演示。
 */
import * as React from 'react';
import {
  Button,
  IconButton,
  Input,
  Textarea,
  Select,
  Checkbox,
  RadioGroup,
  Radio,
  Switch,
  Badge,
  Tag,
  Breadcrumb,
  SearchInput,
  Progress,
  Spinner,
  EmptyState,
  Modal,
  Drawer,
  Tooltip,
  Popover,
  Menu,
  ContextMenu,
  CommandPalette,
  ToastProvider,
  useToast,
  Tabs,
  Tree,
  Table,
  List,
  SplitPane,
  Resizable,
  type MenuOption,
  type TreeNode,
} from '../index';

const selectOptions = [
  { label: '苹果', value: 'apple' },
  { label: '香蕉', value: 'banana' },
  { label: '橙子', value: 'orange' },
];

const menuItems: MenuOption[] = [
  { key: 'rename', label: '重命名' },
  { key: 'duplicate', label: '复制' },
  { key: 'sep', label: '', separator: true },
  { key: 'delete', label: '删除', danger: true },
];

const treeData: TreeNode[] = [
  {
    id: 'src',
    label: 'src',
    children: [
      { id: 'a', label: 'a.tsx' },
      { id: 'b', label: 'b.tsx' },
    ],
  },
  { id: 'readme', label: 'README.md' },
];

const columns = [
  { key: 'id', title: 'ID', width: 80 },
  { key: 'name', title: '名称' },
];
const tableRows = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `行 ${i}` }));
const listItems = Array.from({ length: 200 }, (_, i) => `列表项 ${i}`);

function ToastDemo() {
  const { toast } = useToast();
  return <Button onClick={() => toast({ title: '已保存', description: '操作成功' })}>弹出 Toast</Button>;
}

export function Playground(): React.ReactElement {
  const [modalOpen, setModalOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [cmdOpen, setCmdOpen] = React.useState(false);
  const [checked, setChecked] = React.useState(true);
  const [switchOn, setSwitchOn] = React.useState(false);
  const [inputValue, setInputValue] = React.useState('');

  return (
    <ToastProvider>
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <h1>@ec/ui 组件自检</h1>

        <section>
          <h2>Button / IconButton</h2>
          <Button variant="primary">主要</Button>
          <Button variant="secondary">次要</Button>
          <Button variant="ghost">幽灵</Button>
          <Button variant="danger">危险</Button>
          <Button loading>加载</Button>
          <IconButton aria-label="关闭">×</IconButton>
        </section>

        <section>
          <h2>输入类</h2>
          <Input placeholder="文本框" value={inputValue} onChange={setInputValue} clearable />
          <Textarea placeholder="多行文本" />
          <Select options={selectOptions} placeholder="下拉选择" />
          <SearchInput placeholder="搜索" />
          <Checkbox label="复选" checked={checked} onChange={setChecked} />
          <RadioGroup name="g" defaultValue="a">
            <Radio value="a" label="A" />
            <Radio value="b" label="B" />
          </RadioGroup>
          <Switch aria-label="开关" checked={switchOn} onChange={setSwitchOn} />
        </section>

        <section>
          <h2>反馈</h2>
          <Badge color="success" dot>在线</Badge>
          <Tag closable onClose={() => undefined}>标签</Tag>
          <Progress value={60} />
          <Spinner />
          <EmptyState title="暂无数据" description="请先创建项目" />
        </section>

        <section>
          <h2>浮层</h2>
          <Button onClick={() => setModalOpen(true)}>打开 Modal</Button>
          <Button onClick={() => setDrawerOpen(true)}>打开 Drawer</Button>
          <Tooltip content="提示文本">
            <Button>悬停看 Tooltip</Button>
          </Tooltip>
          <Popover trigger={<Button>打开 Popover</Button>}>
            <div style={{ padding: 12 }}>Popover 内容</div>
          </Popover>
          <Button onClick={() => setCmdOpen(true)}>打开 CommandPalette</Button>
          <ToastDemo />
        </section>

        <section>
          <h2>Menu / ContextMenu</h2>
          <Menu items={menuItems} onSelect={() => undefined} />
          <ContextMenu items={menuItems} onSelect={() => undefined}>
            <div style={{ padding: 24, border: '1px dashed #888' }}>右键此区域</div>
          </ContextMenu>
        </section>

        <section>
          <h2>Tabs</h2>
          <Tabs
            items={[
              { key: 'a', label: '常规' },
              { key: 'b', label: '高级' },
            ]}
          >
            {(active) => <div>当前：{active}</div>}
          </Tabs>
        </section>

        <section>
          <h2>虚拟化：Tree / Table / List（200 条）</h2>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <Tree data={treeData} itemHeight={28} height={200} defaultExpanded={['src']} />
            <Table columns={columns} rows={tableRows} rowKey={(r) => r.id} rowHeight={32} height={200} />
            <List items={listItems} itemHeight={28} height={200} renderItem={(it) => <span>{it}</span>} />
          </div>
        </section>

        <section>
          <h2>SplitPane / Resizable</h2>
          <div style={{ height: 200 }}>
            <SplitPane first={<div>左栏</div>} second={<div>右栏</div>} initial={200} />
          </div>
          <Resizable defaultWidth={180} defaultHeight={100}>
            <div style={{ padding: 8 }}>可拖拽调整</div>
          </Resizable>
        </section>

        <section>
          <h2>Breadcrumb</h2>
          <Breadcrumb
            items={[
              { label: '首页', onClick: () => undefined },
              { label: '项目' },
              { label: '当前' },
            ]}
          />
        </section>

        <Modal open={modalOpen} onOpenChange={setModalOpen} title="示例弹窗">
          <p>这是一个 Modal 示例。</p>
        </Modal>
        <Drawer open={drawerOpen} onOpenChange={setDrawerOpen} title="示例抽屉">
          <p>这是一个 Drawer 示例。</p>
        </Drawer>
        <CommandPalette
          open={cmdOpen}
          onOpenChange={setCmdOpen}
          commands={[
            { id: 'new', title: '新建文件' },
            { id: 'open', title: '打开文件' },
            { id: 'save', title: '保存' },
          ]}
          onSelect={() => setCmdOpen(false)}
        />
      </div>
    </ToastProvider>
  );
}
