export type CommandFieldType = 'text' | 'number' | 'boolean' | 'select';

export interface CommandCatalogField {
  name: string;
  label: string;
  type: CommandFieldType;
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface CommandCatalogEntry {
  id: string;
  title: string;
  category: 'workflow' | 'team' | 'diagnostics' | 'setup' | 'advanced';
  description: string;
  baseArgs: string[];
  fields: CommandCatalogField[];
  risk: 'safe' | 'changes-state' | 'destructive';
  preview: string;
  buildArgs: (values: Record<string, string | number | boolean | undefined>) => string[];
}

function valueText(values: Record<string, string | number | boolean | undefined>, key: string): string {
  const value = values[key];
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function valueBool(values: Record<string, string | number | boolean | undefined>, key: string): boolean {
  return values[key] === true || values[key] === 'true';
}

function requiredText(values: Record<string, string | number | boolean | undefined>, key: string, label: string): string {
  const value = valueText(values, key);
  if (!value) throw new Error(`${label} is required`);
  return value;
}

export const COMMAND_CATALOG: CommandCatalogEntry[] = [
  {
    id: 'doctor',
    title: '설치 점검',
    category: 'diagnostics',
    description: 'OMX/Codex 설치 상태를 점검합니다.',
    baseArgs: ['doctor'],
    fields: [
      { name: 'team', label: 'Team diagnostics', type: 'boolean', defaultValue: false },
    ],
    risk: 'safe',
    preview: 'omx doctor',
    buildArgs: (values) => valueBool(values, 'team') ? ['doctor', '--team'] : ['doctor'],
  },
  {
    id: 'setup',
    title: 'OMX 설정',
    category: 'setup',
    description: '프롬프트, 스킬, 설정 파일을 설치하거나 갱신합니다.',
    baseArgs: ['setup'],
    fields: [
      { name: 'installMode', label: 'Install mode', type: 'select', options: [
        { label: 'Default', value: '' },
        { label: 'Plugin', value: 'plugin' },
        { label: 'Legacy', value: 'legacy' },
      ] },
      { name: 'force', label: 'Force overwrite', type: 'boolean', defaultValue: false },
      { name: 'mergeAgents', label: 'Merge AGENTS.md', type: 'boolean', defaultValue: true },
    ],
    risk: 'changes-state',
    preview: 'omx setup',
    buildArgs: (values) => {
      const args = ['setup'];
      const mode = valueText(values, 'installMode');
      if (mode) args.push(`--${mode}`);
      if (valueBool(values, 'force')) args.push('--force');
      if (valueBool(values, 'mergeAgents')) args.push('--merge-agents');
      return args;
    },
  },
  {
    id: 'team-start',
    title: '팀 실행',
    category: 'team',
    description: '병렬 worker 팀을 시작합니다.',
    baseArgs: ['team'],
    fields: [
      { name: 'workers', label: 'Workers', type: 'number', defaultValue: 3, required: true },
      { name: 'role', label: 'Role', type: 'select', defaultValue: 'executor', options: [
        { label: 'executor', value: 'executor' },
        { label: 'planner', value: 'planner' },
        { label: 'test-engineer', value: 'test-engineer' },
        { label: 'code-reviewer', value: 'code-reviewer' },
      ] },
      { name: 'task', label: 'Task prompt', type: 'text', required: true, placeholder: 'fix failing tests with verification' },
    ],
    risk: 'changes-state',
    preview: 'omx team 3:executor "<task>"',
    buildArgs: (values) => {
      const workers = Math.max(1, Number(values.workers ?? 3));
      const role = valueText(values, 'role') || 'executor';
      const task = requiredText(values, 'task', 'Task prompt');
      return ['team', `${workers}:${role}`, task];
    },
  },
  {
    id: 'team-status',
    title: '팀 상태',
    category: 'team',
    description: '팀 상태와 worker/task 요약을 확인합니다.',
    baseArgs: ['team', 'status'],
    fields: [
      { name: 'teamName', label: 'Team name', type: 'text', required: true },
      { name: 'json', label: 'JSON output', type: 'boolean', defaultValue: false },
    ],
    risk: 'safe',
    preview: 'omx team status <team-name>',
    buildArgs: (values) => {
      const args = ['team', 'status', requiredText(values, 'teamName', 'Team name')];
      if (valueBool(values, 'json')) args.push('--json');
      return args;
    },
  },
  {
    id: 'team-resume',
    title: '팀 이어하기',
    category: 'team',
    description: '기존 팀 런타임을 재개합니다.',
    baseArgs: ['team', 'resume'],
    fields: [
      { name: 'teamName', label: 'Team name', type: 'text', required: true },
    ],
    risk: 'changes-state',
    preview: 'omx team resume <team-name>',
    buildArgs: (values) => ['team', 'resume', requiredText(values, 'teamName', 'Team name')],
  },
  {
    id: 'team-shutdown',
    title: '팀 종료',
    category: 'team',
    description: '팀 worker를 종료하고 상태를 정리합니다.',
    baseArgs: ['team', 'shutdown'],
    fields: [
      { name: 'teamName', label: 'Team name', type: 'text', required: true },
      { name: 'force', label: 'Force', type: 'boolean', defaultValue: false },
    ],
    risk: 'destructive',
    preview: 'omx team shutdown <team-name>',
    buildArgs: (values) => {
      const args = ['team', 'shutdown', requiredText(values, 'teamName', 'Team name')];
      if (valueBool(values, 'force')) args.push('--force');
      return args;
    },
  },
  {
    id: 'hud-json',
    title: 'HUD 상태',
    category: 'diagnostics',
    description: '현재 OMX HUD 상태를 JSON으로 확인합니다.',
    baseArgs: ['hud', '--json'],
    fields: [],
    risk: 'safe',
    preview: 'omx hud --json',
    buildArgs: () => ['hud', '--json'],
  },
  {
    id: 'list',
    title: '스킬/프롬프트 목록',
    category: 'diagnostics',
    description: '패키지된 OMX catalog를 확인합니다.',
    baseArgs: ['list'],
    fields: [
      { name: 'json', label: 'JSON output', type: 'boolean', defaultValue: true },
    ],
    risk: 'safe',
    preview: 'omx list --json',
    buildArgs: (values) => valueBool(values, 'json') ? ['list', '--json'] : ['list'],
  },
  {
    id: 'session-search',
    title: '세션 검색',
    category: 'workflow',
    description: '이전 OMX/Codex 세션 기록을 검색합니다.',
    baseArgs: ['session', 'search'],
    fields: [
      { name: 'query', label: 'Query', type: 'text', required: true },
      { name: 'limit', label: 'Limit', type: 'number', defaultValue: 10 },
      { name: 'json', label: 'JSON output', type: 'boolean', defaultValue: false },
    ],
    risk: 'safe',
    preview: 'omx session search "<query>"',
    buildArgs: (values) => {
      const args = ['session', 'search', requiredText(values, 'query', 'Query'), '--limit', String(values.limit ?? 10)];
      if (valueBool(values, 'json')) args.push('--json');
      return args;
    },
  },
  {
    id: 'auth-list',
    title: 'Auth 슬롯',
    category: 'advanced',
    description: 'Codex OAuth auth slot 상태를 확인합니다.',
    baseArgs: ['auth', 'list'],
    fields: [],
    risk: 'safe',
    preview: 'omx auth list',
    buildArgs: () => ['auth', 'list'],
  },
  {
    id: 'cleanup',
    title: '런타임 정리',
    category: 'advanced',
    description: 'orphaned OMX 프로세스와 stale temp 디렉터리를 정리합니다.',
    baseArgs: ['cleanup'],
    fields: [
      { name: 'dryRun', label: 'Dry run', type: 'boolean', defaultValue: true },
    ],
    risk: 'destructive',
    preview: 'omx cleanup --dry-run',
    buildArgs: (values) => valueBool(values, 'dryRun') ? ['cleanup', '--dry-run'] : ['cleanup'],
  },
];

export function commandById(id: string): CommandCatalogEntry | undefined {
  return COMMAND_CATALOG.find((entry) => entry.id === id);
}

export function buildCatalogArgs(id: string, values: Record<string, string | number | boolean | undefined>): string[] {
  const entry = commandById(id);
  if (!entry) throw new Error(`Unknown OMX command catalog entry: ${id}`);
  return entry.buildArgs(values);
}
