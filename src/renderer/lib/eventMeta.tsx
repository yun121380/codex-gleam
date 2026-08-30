import type { ComponentType } from 'react'
import {
  Bot,
  Brain,
  CircleAlert,
  CircleCheckBig,
  CircleHelp,
  FilePen,
  FilePlus2,
  FileSearch,
  Flag,
  FlaskConical,
  GitCompare,
  MessageCircle,
  ScrollText,
  Terminal,
  Wrench,
  type LucideProps
} from 'lucide-react'
import { EVENT_TYPE_META, type EventTypeMeta } from '@shared/constants'
import type { CodexEventType } from '@shared/types'

const ICONS: Record<string, ComponentType<LucideProps>> = {
  Flag,
  MessageCircle,
  Bot,
  Brain,
  Wrench,
  Terminal,
  ScrollText,
  FileSearch,
  FilePlus2,
  FilePen,
  GitCompare,
  FlaskConical,
  CircleCheckBig,
  CircleAlert,
  CircleHelp
}

export interface ToneClasses {
  /** 图标与强调文字的颜色 */
  text: string
  /** 徽标底色 */
  chip: string
  /** 时间线上的竖线/圆点颜色 */
  dot: string
  /** 选中时的左边条 */
  bar: string
}

const TONES: Record<EventTypeMeta['tone'], ToneClasses> = {
  user: { text: 'text-user', chip: 'bg-user-soft text-user', dot: 'bg-user', bar: 'bg-user' },
  assistant: {
    text: 'text-assistant',
    chip: 'bg-assistant-soft text-assistant',
    dot: 'bg-assistant',
    bar: 'bg-assistant'
  },
  tool: { text: 'text-tool', chip: 'bg-tool-soft text-tool', dot: 'bg-tool', bar: 'bg-tool' },
  shell: { text: 'text-shell', chip: 'bg-shell-soft text-shell', dot: 'bg-shell', bar: 'bg-shell' },
  output: {
    text: 'text-output',
    chip: 'bg-output-soft text-output',
    dot: 'bg-output',
    bar: 'bg-output'
  },
  file: { text: 'text-file', chip: 'bg-file-soft text-file', dot: 'bg-file', bar: 'bg-file' },
  diff: { text: 'text-diff', chip: 'bg-diff-soft text-diff', dot: 'bg-diff', bar: 'bg-diff' },
  test: { text: 'text-test', chip: 'bg-test-soft text-test', dot: 'bg-test', bar: 'bg-test' },
  error: { text: 'text-error', chip: 'bg-error-soft text-error', dot: 'bg-error', bar: 'bg-error' },
  neutral: {
    text: 'text-neutral',
    chip: 'bg-neutral-soft text-neutral',
    dot: 'bg-neutral',
    bar: 'bg-neutral'
  },
  muted: {
    text: 'text-ink-faint',
    chip: 'bg-neutral-soft text-ink-faint',
    dot: 'bg-ink-faint',
    bar: 'bg-ink-faint'
  }
}

export function metaFor(type: CodexEventType): EventTypeMeta {
  return EVENT_TYPE_META[type] ?? EVENT_TYPE_META.unknown
}

export function tonesFor(type: CodexEventType): ToneClasses {
  return TONES[metaFor(type).tone]
}

export function EventIcon({
  type,
  className,
  size = 15
}: {
  type: CodexEventType
  className?: string
  size?: number
}): React.JSX.Element {
  const Icon = ICONS[metaFor(type).icon] ?? CircleHelp
  const props: LucideProps = { size, strokeWidth: 2 }
  if (className !== undefined) props.className = className
  return <Icon {...props} />
}

/** 事件类型过滤器上展示的顺序。 */
export const FILTERABLE_TYPES: CodexEventType[] = [
  'user_message',
  'assistant_message',
  'reasoning',
  'shell_command',
  'command_output',
  'file_edit',
  'file_write',
  'git_diff',
  'test_start',
  'test_result',
  'tool_call',
  'file_read',
  'error',
  'session_start',
  'unknown'
]
