/**
 * 可搜索文本的唯一定义处。
 *
 * **这个模块存在的唯一理由是"知识只存一份"。** 第一层决定往索引里放什么、第二层
 * 决定在会话里搜哪些字段 —— 这两件事必须是同一份定义。分开写的话，某天有人给
 * 第一层加了 `toolName` 而忘了第二层，用户看到的现象是：搜索列出了这个会话，
 * 点进去一个命中都没有，还带一句"命中 0 处"。那不是"没搜到"，那是 bug。
 */
import { SEARCH_MAX_FIELD_LENGTH } from '../../shared/constants'
import type { CodexEvent, SessionSummary } from '../../shared/types'
import { redactText } from '../redaction/redact'

export interface TextField {
  /** 字段来源，界面上用来说明"命中在命令里"还是"在输出里"。 */
  label: string
  /** 已经打过码的文本。 */
  text: string
}

/**
 * 一条可搜索文本 = 打过码的那一份。
 *
 * 这里刻意不接受"要不要打码"这个参数 —— 不给调用方留选择，就不会有人在某条
 * 路径上忘了打。索引是要落盘的，而 `redactSensitive` 那个开关管的是"给界面看
 * 什么"，管不到"往磁盘写什么"。
 *
 * 先截断再打码，不是反过来：一次 `cat` 大文件的输出可以是几 MB，让六轮正则
 * 在整份上跑一遍纯属浪费 —— 超出截断点的内容压根不会进索引。代价是骑在 64 KB
 * 边界上的密钥可能只剩个头，而一个被砍剩十几个字符的残片已经不是密钥了。
 */
function field(label: string, value: string | null | undefined): TextField | null {
  if (value === undefined || value === null || value === '') return null
  const clipped =
    value.length > SEARCH_MAX_FIELD_LENGTH ? value.slice(0, SEARCH_MAX_FIELD_LENGTH) : value
  const text = redactText(clipped)
  return text === '' ? null : { label, text }
}

/**
 * 会话级可搜索字段。
 *
 * 这些进倒排表时归到会话本身，第二层不拿它们定位事件 —— 用户搜项目名时想要的
 * 是"这个会话"，不是"标题这一行"。
 */
export function sessionTextFields(summary: SessionSummary): TextField[] {
  const fields: Array<TextField | null> = [
    field('标题', summary.title),
    field('项目', summary.projectName),
    // 用展示形态（主目录已经是 `~`）而不是完整路径：用户记得的是界面上那一个，
    // 而完整路径里的用户名没必要在这张表里再写一份。
    field('文件', summary.displaySourceFile || summary.sourceFile),
    field('子代理', summary.agent.nickname),
    field('任务', summary.agent.taskPath),
    // 线程 id 是给"我把 id 复制出来了，那次会话在哪"这种找法用的。
    field('会话 id', summary.agent.threadId)
  ]
  return fields.filter((entry): entry is TextField => entry !== null)
}

/**
 * 事件级可搜索字段。逐个字段列，不做"整个对象 JSON.stringify"。
 *
 * **明确不进索引的三类**（写在这里而不是散在别处，因为"没放什么"和"放了什么"
 * 一样需要被记住）：
 *
 * - `raw` —— 它是下面所有字段的原始 JSON，进索引等于把整张表翻一倍，换来的
 *   只有"能搜到 JSON 键名"。
 * - `fileChanges[].before` / `after` —— 整份文件内容，体积第一大户，而它的
 *   有效信息已经在 `diff` 里。
 * - `id` / `callId` / `parserId` / `sourceLine` —— 机器标识，没人搜。
 */
export function eventTextFields(event: CodexEvent): TextField[] {
  const fields: Array<TextField | null> = [
    field('标题', event.title),
    // 命令输出单独给个标签：一条命令和它吐出来的几百行，在界面上说清是哪边命中的。
    field(event.type === 'command_output' ? '输出' : '内容', event.content),
    field('命令', event.command),
    field('工具', event.toolName)
  ]

  // 原始路径与展示路径都进：用户可能记的是 `~/…` 那个形态。同名词条会在
  // collectTerms 的 Set 里合掉，多这一份只多几个词。
  for (const path of event.relatedFiles) fields.push(field('相关文件', path))
  for (const path of event.displayRelatedFiles) fields.push(field('相关文件', path))

  for (const change of event.fileChanges ?? []) {
    fields.push(field('改动文件', change.path))
    fields.push(field('改动文件', change.displayPath))
    fields.push(field('代码差异', change.diff))
  }

  // 失败的测试名是高价值检索词 —— "上次那个 flaky 的用例叫什么"就是这么找的。
  for (const failure of event.test?.failures ?? []) {
    fields.push(field('测试', failure.name))
    fields.push(field('测试输出', failure.message))
  }

  return fields.filter((entry): entry is TextField => entry !== null)
}
