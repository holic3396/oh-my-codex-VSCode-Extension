import * as vscode from 'vscode';

type LocaleKey = 'ko' | 'en';

export interface UiStrings {
  chatTitle: string;
  openControlCenter: string;
  openLogExplorer: string;
  controlCenterTitle: string;
  logExplorerTitle: string;
  refresh: string;
  run: string;
  preview: string;
  stop: string;
  doctor: string;
  startWork: string;
  resumeWork: string;
  teamRun: string;
  viewLogs: string;
  inputNeeded: string;
  currentWork: string;
  milestones: string;
  recentResult: string;
  commandLauncher: string;
  teams: string;
  workers: string;
  tasks: string;
  tmuxPanes: string;
  paneTail: string;
  sendToLeader: string;
  logSearch: string;
  query: string;
  source: string;
  all: string;
  openLog: string;
  confirmDangerous: string;
  confirmRun: string;
}

const ko: UiStrings = {
  chatTitle: 'OMX Chat',
  openControlCenter: 'Control Center',
  openLogExplorer: '로그',
  controlCenterTitle: 'OMX Control Center',
  logExplorerTitle: 'OMX Log Explorer',
  refresh: '새로고침',
  run: '실행',
  preview: '미리보기',
  stop: '중단',
  doctor: '설치 점검',
  startWork: '작업 시작',
  resumeWork: '이어하기',
  teamRun: '팀 실행',
  viewLogs: '로그 보기',
  inputNeeded: '입력 필요',
  currentWork: '현재 작업',
  milestones: '진행 단계',
  recentResult: '최근 결과',
  commandLauncher: 'OMX 런처',
  teams: '팀',
  workers: '워커',
  tasks: '태스크',
  tmuxPanes: 'tmux Pane',
  paneTail: 'Pane 출력',
  sendToLeader: 'Leader로 보내기',
  logSearch: '로그 검색',
  query: '검색어',
  source: '소스',
  all: '전체',
  openLog: '원문 열기',
  confirmDangerous: '위험하거나 상태를 바꾸는 OMX 명령입니다. 실행할까요?',
  confirmRun: 'OMX 명령을 실행할까요?',
};

const en: UiStrings = {
  chatTitle: 'OMX Chat',
  openControlCenter: 'Control Center',
  openLogExplorer: 'Logs',
  controlCenterTitle: 'OMX Control Center',
  logExplorerTitle: 'OMX Log Explorer',
  refresh: 'Refresh',
  run: 'Run',
  preview: 'Preview',
  stop: 'Stop',
  doctor: 'Doctor',
  startWork: 'Start Work',
  resumeWork: 'Resume',
  teamRun: 'Run Team',
  viewLogs: 'View Logs',
  inputNeeded: 'Input Needed',
  currentWork: 'Current Work',
  milestones: 'Milestones',
  recentResult: 'Recent Result',
  commandLauncher: 'OMX Launcher',
  teams: 'Teams',
  workers: 'Workers',
  tasks: 'Tasks',
  tmuxPanes: 'tmux Panes',
  paneTail: 'Pane Tail',
  sendToLeader: 'Send to Leader',
  logSearch: 'Log Search',
  query: 'Query',
  source: 'Source',
  all: 'All',
  openLog: 'Open Log',
  confirmDangerous: 'This OMX command can change state or has operational risk. Run it?',
  confirmRun: 'Run this OMX command?',
};

export function localeKey(): LocaleKey {
  return vscode.env.language.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export function uiStrings(): UiStrings {
  return localeKey() === 'ko' ? ko : en;
}
