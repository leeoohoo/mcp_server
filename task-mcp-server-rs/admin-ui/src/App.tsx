import React, { useEffect, useState } from 'react';
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
  Select,
  InputNumber,
  Modal,
  Switch,
  Card,
  Descriptions,
  message,
  Divider,
  Popconfirm
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { apiGet, apiPost } from './api';
import type { StatusResponse, Task } from './types';

const { Header, Content } = Layout;
const { Title, Text } = Typography;

function formatDate(value?: string) {
  if (!value) return '';
  return value.replace('T', ' ').replace('Z', '');
}

function markdownText(value?: string) {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : '_No details_';
}

function statusColor(value: string) {
  if (value === 'done') return 'green';
  if (value === 'doing') return 'blue';
  if (value === 'blocked') return 'red';
  return 'default';
}

function priorityColor(value: string) {
  if (value === 'high') return 'red';
  if (value === 'low') return 'blue';
  return 'gold';
}

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);

  const [statusFilter, setStatusFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [includeDone, setIncludeDone] = useState(true);
  const [allSessions, setAllSessions] = useState(true);
  const [allRuns, setAllRuns] = useState(true);
  const [sessionId, setSessionId] = useState('');
  const [runId, setRunId] = useState('');
  const [limit, setLimit] = useState(100);

  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [taskForm] = Form.useForm();

  const [completeModalOpen, setCompleteModalOpen] = useState(false);
  const [completeNote, setCompleteNote] = useState('');
  const [completeTaskId, setCompleteTaskId] = useState<string | null>(null);

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

  const refreshTasks = async () => {
    setTasksLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (tagFilter) params.set('tag', tagFilter);
      params.set('include_done', includeDone ? 'true' : 'false');
      if (limit) params.set('limit', String(limit));
      if (sessionId) params.set('session_id', sessionId);
      if (runId) params.set('run_id', runId);
      if (allSessions) params.set('all_sessions', 'true');
      if (allRuns) params.set('all_runs', 'true');
      const url = params.toString() ? `/api/tasks?${params.toString()}` : '/api/tasks';
      const data = await apiGet<{ tasks: Task[] }>(url);
      setTasks(Array.isArray(data.tasks) ? data.tasks : []);
    } catch (err) {
      message.error(String(err));
    } finally {
      setTasksLoading(false);
    }
  };

  useEffect(() => {
    refreshStatus();
    refreshTasks();
  }, []);

  const openTaskModal = (task?: Task) => {
    setEditingTask(task ?? null);
    if (task) {
      taskForm.setFieldsValue({
        title: task.title,
        details: task.details,
        status: task.status,
        priority: task.priority,
        tags: task.tags,
        session_id: task.session_id,
        run_id: task.run_id,
        user_message_id: task.user_message_id
      });
    } else {
      taskForm.resetFields();
      taskForm.setFieldsValue({
        status: 'todo',
        priority: 'medium',
        tags: []
      });
    }
    setTaskModalOpen(true);
  };

  const handleSaveTask = async () => {
    try {
      const values = await taskForm.validateFields();
      if (editingTask) {
        await apiPost('/api/tasks/update', {
          id: editingTask.id,
          title: values.title,
          details: values.details,
          status: values.status,
          priority: values.priority,
          tags: values.tags || [],
          append_note: values.append_note || undefined
        });
        message.success('Task updated');
      } else {
        await apiPost('/api/tasks', {
          title: values.title,
          details: values.details,
          status: values.status,
          priority: values.priority,
          tags: values.tags || [],
          session_id: values.session_id || undefined,
          run_id: values.run_id || undefined,
          user_message_id: values.user_message_id || undefined
        });
        message.success('Task created');
      }
      setTaskModalOpen(false);
      setEditingTask(null);
      await refreshTasks();
    } catch (err) {
      message.error(String(err));
    }
  };

  const handleComplete = async () => {
    if (!completeTaskId) return;
    if (completeNote.trim().length < 5) {
      message.error('Completion note must be at least 5 characters');
      return;
    }
    try {
      await apiPost('/api/tasks/complete', { id: completeTaskId, note: completeNote });
      message.success('Task completed');
      setCompleteModalOpen(false);
      setCompleteNote('');
      setCompleteTaskId(null);
      await refreshTasks();
    } catch (err) {
      message.error(String(err));
    }
  };

  const handleClearDone = async () => {
    try {
      await apiPost('/api/tasks/clear', { mode: 'done', all_sessions: true, all_runs: true });
      message.success('Done tasks cleared');
      await refreshTasks();
    } catch (err) {
      message.error(String(err));
    }
  };

  const taskColumns: ColumnsType<Task> = [
    { title: 'Title', dataIndex: 'title', key: 'title' },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (value) => <Tag color={statusColor(value)}>{value}</Tag>
    },
    {
      title: 'Priority',
      dataIndex: 'priority',
      key: 'priority',
      render: (value) => <Tag color={priorityColor(value)}>{value}</Tag>
    },
    {
      title: 'Tags',
      dataIndex: 'tags',
      key: 'tags',
      render: (value: string[]) => (value || []).map((tag) => <Tag key={tag}>{tag}</Tag>)
    },
    { title: 'Session', dataIndex: 'session_id', key: 'session_id' },
    { title: 'Run', dataIndex: 'run_id', key: 'run_id' },
    { title: 'Updated', dataIndex: 'updated_at', key: 'updated_at', render: (value) => formatDate(value) },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, record) => (
        <Space>
          <Button size="small" onClick={() => openTaskModal(record)}>
            Edit
          </Button>
          <Button
            size="small"
            type="primary"
            disabled={record.status === 'done'}
            onClick={() => {
              setCompleteTaskId(record.id);
              setCompleteNote('');
              setCompleteModalOpen(true);
            }}
          >
            Complete
          </Button>
        </Space>
      )
    }
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Title level={4} style={{ color: 'white', margin: 0 }}>Task MCP Admin</Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={refreshStatus} loading={statusLoading}>Refresh Status</Button>
        </Space>
      </Header>
      <Content style={{ padding: 24 }}>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Card size="small" title="Status">
            <Descriptions
              size="small"
              bordered
              column={2}
              items={[
                { key: 'server', label: 'Server', children: status?.server_name || '-' },
                { key: 'db', label: 'DB', children: status?.db_path || '-' },
                { key: 'session', label: 'Session', children: status?.session_id || '-' },
                { key: 'run', label: 'Run', children: status?.run_id || '-' }
              ]}
            />
          </Card>

          <Card size="small" title="Tasks">
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Space wrap>
                <Select
                  value={statusFilter}
                  onChange={(value) => setStatusFilter(value)}
                  style={{ width: 140 }}
                  options={[
                    { value: '', label: 'All Statuses' },
                    { value: 'todo', label: 'Todo' },
                    { value: 'doing', label: 'Doing' },
                    { value: 'blocked', label: 'Blocked' },
                    { value: 'done', label: 'Done' }
                  ]}
                />
                <Input
                  placeholder="Tag"
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                  style={{ width: 160 }}
                />
                <Input
                  placeholder="Session ID"
                  value={sessionId}
                  onChange={(e) => setSessionId(e.target.value)}
                  style={{ width: 180 }}
                  disabled={allSessions}
                />
                <Input
                  placeholder="Run ID"
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                  style={{ width: 180 }}
                  disabled={allRuns}
                />
                <Space>
                  <Text>All Sessions</Text>
                  <Switch checked={allSessions} onChange={(checked) => setAllSessions(checked)} />
                </Space>
                <Space>
                  <Text>All Runs</Text>
                  <Switch checked={allRuns} onChange={(checked) => setAllRuns(checked)} />
                </Space>
                <Space>
                  <Text>Include Done</Text>
                  <Switch checked={includeDone} onChange={(checked) => setIncludeDone(checked)} />
                </Space>
                <Space>
                  <Text>Limit</Text>
                  <InputNumber min={1} max={500} value={limit} onChange={(value) => setLimit(value || 50)} />
                </Space>
                <Button type="primary" icon={<PlusOutlined />} onClick={() => openTaskModal()}>
                  New Task
                </Button>
                <Button onClick={refreshTasks} loading={tasksLoading}>Refresh</Button>
                <Popconfirm
                  title="Clear done tasks?"
                  onConfirm={handleClearDone}
                  okText="Clear"
                >
                  <Button danger>Clear Done</Button>
                </Popconfirm>
              </Space>
              <Table
                rowKey="id"
                dataSource={tasks}
                columns={taskColumns}
                loading={tasksLoading}
                onRow={(record) => ({
                  onClick: () => setSelectedTask(record)
                })}
              />
            </Space>
          </Card>
        </Space>
      </Content>

      <Drawer
        title="Task Details"
        width={860}
        open={!!selectedTask}
        onClose={() => setSelectedTask(null)}
      >
        {selectedTask ? (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Card size="small" title={selectedTask.title}>
              <Descriptions
                size="small"
                bordered
                column={2}
                items={[
                  { key: 'status', label: 'Status', children: <Tag color={statusColor(selectedTask.status)}>{selectedTask.status}</Tag> },
                  { key: 'priority', label: 'Priority', children: <Tag color={priorityColor(selectedTask.priority)}>{selectedTask.priority}</Tag> },
                  { key: 'session', label: 'Session', children: selectedTask.session_id || '-' },
                  { key: 'run', label: 'Run', children: selectedTask.run_id || '-' },
                  { key: 'user', label: 'User Message', children: selectedTask.user_message_id || '-' },
                  { key: 'created', label: 'Created', children: formatDate(selectedTask.created_at) },
                  { key: 'updated', label: 'Updated', children: formatDate(selectedTask.updated_at) },
                  {
                    key: 'tags',
                    label: 'Tags',
                    children: (selectedTask.tags || []).map((tag) => <Tag key={tag}>{tag}</Tag>)
                  }
                ]}
              />
              <Divider />
              <Title level={5}>Details</Title>
              <div style={{ background: '#0f172a', color: '#e2e8f0', padding: 12, borderRadius: 8 }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {markdownText(selectedTask.details)}
                </ReactMarkdown>
              </div>
              <Divider />
              <Space>
                <Button onClick={() => openTaskModal(selectedTask)}>Edit</Button>
                <Button
                  type="primary"
                  disabled={selectedTask.status === 'done'}
                  onClick={() => {
                    setCompleteTaskId(selectedTask.id);
                    setCompleteNote('');
                    setCompleteModalOpen(true);
                  }}
                >
                  Complete
                </Button>
              </Space>
            </Card>
          </Space>
        ) : null}
      </Drawer>

      <Modal
        title={editingTask ? 'Edit Task' : 'New Task'}
        open={taskModalOpen}
        onCancel={() => setTaskModalOpen(false)}
        onOk={handleSaveTask}
        okText="Save"
      >
        <Form form={taskForm} layout="vertical">
          <Form.Item label="Title" name="title" rules={[{ required: true, message: 'Title required' }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Details" name="details">
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item label="Status" name="status">
            <Select
              options={[
                { value: 'todo', label: 'Todo' },
                { value: 'doing', label: 'Doing' },
                { value: 'blocked', label: 'Blocked' },
                { value: 'done', label: 'Done' }
              ]}
            />
          </Form.Item>
          <Form.Item label="Priority" name="priority">
            <Select
              options={[
                { value: 'high', label: 'High' },
                { value: 'medium', label: 'Medium' },
                { value: 'low', label: 'Low' }
              ]}
            />
          </Form.Item>
          <Form.Item label="Tags" name="tags">
            <Select mode="tags" tokenSeparators={[',']} />
          </Form.Item>
          {editingTask ? (
            <Form.Item label="Append Note" name="append_note">
              <Input.TextArea rows={3} placeholder="Optional note to append" />
            </Form.Item>
          ) : null}
          {!editingTask ? (
            <>
              <Form.Item label="Session ID" name="session_id">
                <Input />
              </Form.Item>
              <Form.Item label="Run ID" name="run_id">
                <Input />
              </Form.Item>
              <Form.Item label="User Message ID" name="user_message_id">
                <Input />
              </Form.Item>
            </>
          ) : null}
        </Form>
      </Modal>

      <Modal
        title="Complete Task"
        open={completeModalOpen}
        onCancel={() => setCompleteModalOpen(false)}
        onOk={handleComplete}
        okText="Complete"
      >
        <Form layout="vertical">
          <Form.Item label="Completion Note" required>
            <Input.TextArea rows={3} value={completeNote} onChange={(e) => setCompleteNote(e.target.value)} />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}
