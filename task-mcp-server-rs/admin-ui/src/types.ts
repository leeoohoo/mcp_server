export interface Task {
  id: string;
  title: string;
  details: string;
  status: string;
  priority: string;
  tags: string[];
  run_id: string;
  session_id: string;
  user_message_id: string;
  created_at: string;
  updated_at: string;
}

export interface StatusResponse {
  ok: boolean;
  server_name: string;
  db_path: string;
  session_id: string;
  run_id: string;
}
