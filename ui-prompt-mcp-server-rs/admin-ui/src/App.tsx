import React, { useEffect, useMemo, useState } from 'react';
import {
  Layout,
  Typography,
  Space,
  Button,
  Table,
  Tag,
  Drawer,
  Form,
  Input,
  Checkbox,
  Radio,
  Card,
  Descriptions,
  message,
  Select,
  InputNumber
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined } from '@ant-design/icons';
import { apiGet, apiPost } from './api';
import type { ChoiceOption, KvField, PromptEntry, PromptPayload, StatusResponse } from './types';

const { Header, Content } = Layout;
const { Title, Text } = Typography;

function formatDate(value?: string) {
  if (!value) return '';
  return value.replace('T', ' ').replace('Z', '');
}

function statusLabel(status: string) {
  if (status === 'pending') return '待处理';
  if (status === 'ok') return '已处理';
  if (status === 'canceled') return '已取消';
  if (status === 'timeout') return '超时';
  return status || '未知';
}

function statusColor(status: string) {
  if (status === 'pending') return 'orange';
  if (status === 'ok') return 'green';
  if (status === 'timeout') return 'red';
  if (status === 'canceled') return 'default';
  return 'default';
}

function kindLabel(kind?: string) {
  if (kind === 'kv') return '填写';
  if (kind === 'choice') return '选择';
  return kind || '未知';
}

function promptTitle(prompt?: PromptPayload | null) {
  const title = prompt?.title?.trim();
  if (title) return title;
  if (prompt?.kind === 'kv') return '信息补充';
  if (prompt?.kind === 'choice') return '选择确认';
  return '待办项';
}

function normalizeSelection(value: any, multiple: boolean) {
  if (multiple) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) return [value];
    return [] as string[];
  }
  if (typeof value === 'string') return value;
  return '';
}

function buildKvInitial(prompt: PromptPayload, response?: any, preferResponse?: boolean) {
  const initial: Record<string, string> = {};
  if (preferResponse && response && typeof response.values === 'object' && response.values) {
    Object.entries(response.values as Record<string, any>).forEach(([key, value]) => {
      initial[key] = value == null ? '' : String(value);
    });
    return initial;
  }
  (prompt.fields || []).forEach((field) => {
    if (!field || !field.key) return;
    if (typeof field.default === 'string' && field.default.trim()) {
      initial[field.key] = field.default;
    }
  });
  return initial;
}

function resolveChoiceLimits(prompt: PromptPayload) {
  const optionCount = (prompt.options || []).length;
  const multiple = Boolean(prompt.multiple);
  const minSelections =
    typeof prompt.minSelections === 'number'
      ? prompt.minSelections
      : multiple
        ? 0
        : 1;
  const maxSelections =
    typeof prompt.maxSelections === 'number'
      ? prompt.maxSelections
      : multiple
        ? optionCount || 1
        : 1;
  return {
    multiple,
    minSelections: Math.max(0, Math.min(minSelections, optionCount || minSelections)),
    maxSelections: Math.max(1, Math.min(maxSelections, optionCount || maxSelections))
  };
}

function optionLabel(option: ChoiceOption) {
  return option.label && option.label.trim() ? option.label : option.value;
}

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const [prompts, setPrompts] = useState<PromptEntry[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);

  const [statusFilter, setStatusFilter] = useState('pending');
  const [limit, setLimit] = useState(200);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedPrompt, setSelectedPrompt] = useState<PromptEntry | null>(null);
  const [responding, setResponding] = useState(false);
  const [form] = Form.useForm();

  const refreshStatus = async () => {
    setStatusLoading(true);
    try {
      const data = await apiGet<StatusResponse>('/api/status');
      setStatus(data);
    } catch (err) {
      message.error(String(err));
    } finally {
      setStatusLoading(false);
    }
  };

  const refreshPrompts = async () => {
    setPromptsLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter && statusFilter !== 'all') {
        params.set('status', statusFilter);
      }
      if (limit) params.set('limit', String(limit));
      const url = params.toString() ? `/api/prompts?${params.toString()}` : '/api/prompts';
      const data = await apiGet<{ prompts: PromptEntry[] }>(url);
      setPrompts(Array.isArray(data.prompts) ? data.prompts : []);
    } catch (err) {
      message.error(String(err));
    } finally {
      setPromptsLoading(false);
    }
  };

  const refreshAll = async () => {
    await Promise.all([refreshStatus(), refreshPrompts()]);
  };

  useEffect(() => {
    refreshStatus();
  }, []);

  useEffect(() => {
    refreshPrompts();
  }, [statusFilter, limit]);

  const openPrompt = (entry: PromptEntry) => {
    const prompt = entry.prompt || {};
    const response = entry.response || {};
    form.resetFields();
    if (prompt.kind === 'kv') {
      const initial = buildKvInitial(prompt, response, entry.status !== 'pending');
      form.setFieldsValue(initial);
    } else if (prompt.kind === 'choice') {
      const { multiple } = resolveChoiceLimits(prompt);
      let selection: any = prompt.default;
      if (entry.status !== 'pending' && response && response.selection !== undefined) {
        selection = response.selection;
      }
      form.setFieldsValue({ selection: normalizeSelection(selection, multiple) });
    }
    setSelectedPrompt(entry);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setSelectedPrompt(null);
    form.resetFields();
  };

  const handleSubmit = async () => {
    if (!selectedPrompt) return;
    const prompt = selectedPrompt.prompt || {};
    setResponding(true);
    try {
      if (prompt.kind === 'kv') {
        const values = await form.validateFields();
        await apiPost('/api/prompts/respond', {
          request_id: selectedPrompt.request_id,
          status: 'ok',
          response: { status: 'ok', values }
        });
      } else if (prompt.kind === 'choice') {
        const limits = resolveChoiceLimits(prompt);
        const selectionRaw = form.getFieldValue('selection');
        const selection = normalizeSelection(selectionRaw, limits.multiple);
        if (limits.multiple) {
          const list = Array.isArray(selection) ? selection : [];
          if (list.length < limits.minSelections) {
            message.error(`至少选择 ${limits.minSelections} 项`);
            return;
          }
          if (list.length > limits.maxSelections) {
            message.error(`最多选择 ${limits.maxSelections} 项`);
            return;
          }
        } else if (limits.minSelections >= 1 && (!selection || selection === '')) {
          message.error('请选择一项');
          return;
        }
        await apiPost('/api/prompts/respond', {
          request_id: selectedPrompt.request_id,
          status: 'ok',
          response: { status: 'ok', selection }
        });
      } else {
        message.error('未知的提示类型');
        return;
      }
      message.success('已提交');
      closeDrawer();
      await refreshPrompts();
    } catch (err) {
      message.error(String(err));
    } finally {
      setResponding(false);
    }
  };

  const handleCancelPrompt = async () => {
    if (!selectedPrompt) return;
    setResponding(true);
    try {
      await apiPost('/api/prompts/respond', {
        request_id: selectedPrompt.request_id,
        status: 'canceled',
        response: { status: 'canceled' }
      });
      message.success('已取消');
      closeDrawer();
      await refreshPrompts();
    } catch (err) {
      message.error(String(err));
    } finally {
      setResponding(false);
    }
  };

  const columns: ColumnsType<PromptEntry> = [
    {
      title: '时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      render: (value, record) => formatDate(value || record.created_at)
    },
    {
      title: '标题',
      key: 'title',
      render: (_, record) => promptTitle(record.prompt)
    },
    {
      title: '类型',
      key: 'kind',
      render: (_, record) => {
        const kind = record.prompt?.kind;
        return <Tag>{kindLabel(kind)}</Tag>;
      }
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (value) => <Tag color={statusColor(value)}>{statusLabel(value)}</Tag>
    },
    {
      title: 'Request',
      dataIndex: 'request_id',
      key: 'request_id',
      render: (value) => (value ? value.slice(0, 8) : '-')
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Button type="link" onClick={() => openPrompt(record)}>
          {record.status === 'pending' ? '处理' : '查看'}
        </Button>
      )
    }
  ];

  const drawerContent = useMemo(() => {
    if (!selectedPrompt) return null;
    const prompt = selectedPrompt.prompt || {};
    const response = selectedPrompt.response || {};
    const allowCancel = prompt.allowCancel !== false;
    const isPending = selectedPrompt.status === 'pending';
    const limits = resolveChoiceLimits(prompt);

    return (
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card size="small" title="基本信息">
          <Descriptions
            size="small"
            bordered
            column={2}
            items={[
              { key: 'id', label: 'Request', children: selectedPrompt.request_id },
              {
                key: 'status',
                label: '状态',
                children: <Tag color={statusColor(selectedPrompt.status)}>{statusLabel(selectedPrompt.status)}</Tag>
              },
              { key: 'kind', label: '类型', children: kindLabel(prompt.kind) },
              { key: 'updated', label: '更新时间', children: formatDate(selectedPrompt.updated_at) || '-' }
            ]}
          />
          {prompt.message ? (
            <div style={{ marginTop: 12 }}>
              <Text type="secondary">{prompt.message}</Text>
            </div>
          ) : null}
        </Card>

        {selectedPrompt.status !== 'pending' ? (
          <Card size="small" title="处理结果">
            {prompt.kind === 'kv' && response && response.values && typeof response.values === 'object' ? (
              <Descriptions
                size="small"
                bordered
                column={1}
                items={Object.entries(response.values as Record<string, any>).map(([key, value]) => ({
                  key,
                  label: key,
                  children: value == null ? '-' : String(value)
                }))}
              />
            ) : null}
            {prompt.kind === 'choice' && response ? (
              <Text>{Array.isArray(response.selection) ? response.selection.join(', ') : response.selection || '-'}</Text>
            ) : null}
            {!response || (prompt.kind === 'kv' && (!response.values || Object.keys(response.values || {}).length === 0)) ? (
              <Text type="secondary">无返回内容</Text>
            ) : null}
          </Card>
        ) : null}

        {prompt.kind === 'kv' ? (
          <Card size="small" title="填写信息">
            <Form form={form} layout="vertical" disabled={!isPending}>
              {(prompt.fields || []).map((field: KvField) => {
                const label = field.label && field.label.trim() ? field.label : field.key;
                const placeholder = field.placeholder || '';
                const description = field.description && field.description.trim() ? field.description : '';
                const requiredRule = field.required ? [{ required: true, message: '必填' }] : undefined;
                if (field.multiline) {
                  return (
                    <Form.Item
                      key={field.key}
                      name={field.key}
                      label={label}
                      extra={description || undefined}
                      rules={requiredRule}
                    >
                      <Input.TextArea placeholder={placeholder} autoSize={{ minRows: 3, maxRows: 8 }} />
                    </Form.Item>
                  );
                }
                if (field.secret) {
                  return (
                    <Form.Item
                      key={field.key}
                      name={field.key}
                      label={label}
                      extra={description || undefined}
                      rules={requiredRule}
                    >
                      <Input.Password placeholder={placeholder} />
                    </Form.Item>
                  );
                }
                return (
                  <Form.Item
                    key={field.key}
                    name={field.key}
                    label={label}
                    extra={description || undefined}
                    rules={requiredRule}
                  >
                    <Input placeholder={placeholder} />
                  </Form.Item>
                );
              })}
            </Form>
          </Card>
        ) : null}

        {prompt.kind === 'choice' ? (
          <Card size="small" title="选择项">
            <Form form={form} layout="vertical" disabled={!isPending}>
              <Form.Item
                name="selection"
                label={limits.multiple ? '多选' : '单选'}
                extra={
                  limits.multiple
                    ? `至少 ${limits.minSelections} 项，最多 ${limits.maxSelections} 项`
                    : undefined
                }
              >
                {limits.multiple ? (
                  <Checkbox.Group style={{ width: '100%' }}>
                    <Space direction="vertical">
                      {(prompt.options || []).map((option) => (
                        <Checkbox key={option.value} value={option.value}>
                          <Space direction="vertical" size={0}>
                            <Text>{optionLabel(option)}</Text>
                            {option.description ? (
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {option.description}
                              </Text>
                            ) : null}
                          </Space>
                        </Checkbox>
                      ))}
                    </Space>
                  </Checkbox.Group>
                ) : (
                  <Radio.Group>
                    <Space direction="vertical">
                      {(prompt.options || []).map((option) => (
                        <Radio key={option.value} value={option.value}>
                          <Space direction="vertical" size={0}>
                            <Text>{optionLabel(option)}</Text>
                            {option.description ? (
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {option.description}
                              </Text>
                            ) : null}
                          </Space>
                        </Radio>
                      ))}
                    </Space>
                  </Radio.Group>
                )}
              </Form.Item>
            </Form>
          </Card>
        ) : null}

        {isPending ? (
          <Space>
            <Button type="primary" onClick={handleSubmit} loading={responding}>
              提交
            </Button>
            {allowCancel ? (
              <Button onClick={handleCancelPrompt} loading={responding}>
                取消
              </Button>
            ) : null}
          </Space>
        ) : null}
      </Space>
    );
  }, [selectedPrompt, responding]);

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Title level={4} style={{ color: 'white', margin: 0 }}>UI Prompt Admin</Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={refreshAll} loading={statusLoading || promptsLoading}>
            刷新
          </Button>
        </Space>
      </Header>
      <Content style={{ padding: 24 }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Card size="small" title="状态">
            <Descriptions
              size="small"
              bordered
              column={2}
              items={[
                { key: 'server', label: 'Server', children: status?.server_name || '-' },
                { key: 'db', label: 'DB', children: status?.db_path || '-' }
              ]}
            />
          </Card>

          <Card size="small" title="待办列表">
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Space wrap>
                <Select
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { value: 'pending', label: '仅待处理' },
                    { value: 'handled', label: '仅已处理' },
                    { value: 'all', label: '全部' }
                  ]}
                />
                <Space>
                  <Text>Limit</Text>
                  <InputNumber
                    min={10}
                    max={1000}
                    value={limit}
                    onChange={(value) => setLimit(Number(value) || 200)}
                  />
                </Space>
                <Button onClick={refreshPrompts} loading={promptsLoading}>刷新列表</Button>
              </Space>
              <Table
                rowKey="request_id"
                columns={columns}
                dataSource={prompts}
                loading={promptsLoading}
                pagination={{ pageSize: 20 }}
              />
            </Space>
          </Card>
        </Space>
      </Content>
      <Drawer
        title={selectedPrompt ? promptTitle(selectedPrompt.prompt) : '提示详情'}
        open={drawerOpen}
        width={640}
        onClose={closeDrawer}
        destroyOnClose
      >
        {drawerContent}
      </Drawer>
    </Layout>
  );
}
