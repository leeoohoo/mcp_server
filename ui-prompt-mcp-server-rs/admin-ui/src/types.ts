export interface StatusResponse {
  ok?: boolean;
  server_name: string;
  db_path: string;
}

export interface KvField {
  key: string;
  label?: string;
  description?: string;
  placeholder?: string;
  default?: string;
  required?: boolean;
  multiline?: boolean;
  secret?: boolean;
}

export interface ChoiceOption {
  value: string;
  label?: string;
  description?: string;
}

export interface PromptPayload {
  kind?: string;
  title?: string;
  message?: string;
  allowCancel?: boolean;
  fields?: KvField[];
  multiple?: boolean;
  options?: ChoiceOption[];
  default?: string | string[];
  minSelections?: number;
  maxSelections?: number;
}

export interface PromptEntry {
  request_id: string;
  status: string;
  prompt?: PromptPayload | null;
  response?: any;
  created_at?: string;
  updated_at?: string;
}
