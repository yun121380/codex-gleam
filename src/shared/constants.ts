import type { AppSettings, CodexEventType, ExportOptions } from './types'

export const APP_NAME = '拾光'
export const APP_TAGLINE = '本地离线的 Codex 会话查看器'

/** 扫描时永远跳过的目录名（大小写不敏感）。 */
export const IGNORED_DIR_NAMES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'cache',
  'temp',
  'logs',
  // 下面几个不在规格里，但同属"绝不可能放会话、却极易拖慢扫描"的目录。
  '.pnpm-store',
  '.venv',
  '__pycache__',
  'target',
  'out'
]

/** 只有这些扩展名会被检查。 */
export const ALLOWED_EXTENSIONS: readonly string[] = ['.json', '.jsonl']

export const DEFAULT_MAX_DEPTH = 6
export const DEFAULT_MAX_FILE_SIZE_MB = 100
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.3

/** 指纹识别只读取文件开头这么多字节，绝不整文件载入内存。 */
export const FINGERPRINT_HEAD_BYTES = 64 * 1024

/** 解析单个会话时，最多读取的行数与字节数，避免超大文件拖垮界面。 */
export const MAX_PARSED_LINES = 50_000
export const MAX_PARSED_BYTES = 32 * 1024 * 1024

/** 单条事件内容在界面上默认截断的长度（完整内容仍保留在 raw 中）。 */
export const CONTENT_PREVIEW_LIMIT = 4000

/**
 * Codex 会话指纹信号。命中即加分，同一信号只计一次。
 * 权重越高表示越"像 Codex 会话"而不是普通 JSON。
 */
export const FINGERPRINT_SIGNALS: ReadonlyArray<{ token: string; weight: number }> = [
  { token: 'session_id', weight: 3 },
  { token: 'sessionid', weight: 3 },
  { token: 'tool_calls', weight: 3 },
  { token: 'tool_call', weight: 3 },
  { token: 'working_directory', weight: 3 },
  { token: 'conversation', weight: 3 },
  { token: 'function_call', weight: 2 },
  { token: 'apply_patch', weight: 2 },
  { token: 'turns', weight: 2 },
  { token: 'session', weight: 2 },
  { token: 'messages', weight: 2 },
  { token: 'events', weight: 2 },
  { token: 'assistant', weight: 2 },
  { token: 'workspace', weight: 2 },
  { token: 'response_item', weight: 2 },
  { token: 'command', weight: 1 },
  { token: 'shell', weight: 1 },
  { token: 'timestamp', weight: 1 },
  { token: 'user', weight: 1 },
  { token: 'role', weight: 1 },
  { token: 'content', weight: 1 },
  { token: 'cwd', weight: 1 },
  { token: 'model', weight: 1 },
  { token: 'instructions', weight: 1 },
  { token: 'codex', weight: 1 }
]

/** 反向信号：命中说明这是配置文件而不是会话。 */
export const FINGERPRINT_NEGATIVE_SIGNALS: ReadonlyArray<{ token: string; weight: number }> = [
  { token: 'compileroptions', weight: 6 },
  { token: 'devdependencies', weight: 6 },
  { token: 'peerdependencies', weight: 4 },
  { token: 'browserslist', weight: 4 },
  { token: 'lockfileversion', weight: 6 },
  { token: 'eslintconfig', weight: 4 },
  { token: 'packagemanager', weight: 3 },
  { token: '$schema', weight: 3 },
  { token: 'stylelint', weight: 3 }
]

/** 正向得分达到该值即视为满分 1.0。 */
export const FINGERPRINT_SATURATION = 10

export const CONFIDENCE_HIGH = 0.7
export const CONFIDENCE_MEDIUM = 0.45

/** 打码后显示的占位符。 */
export const REDACTION_PLACEHOLDER = '[已打码]'

/**
 * 嵌套太深、不再展开时的占位符。
 *
 * 和 REDACTION_PLACEHOLDER 分开：那个表示"这里本来是个密钥"，
 * 这个只表示"这里太深了没往下看"，别让用户误会自己的数据里有密钥。
 */
export const DEPTH_LIMIT_PLACEHOLDER = '[嵌套过深，未展开]'

/**
 * 深度打码最多往下走多少层。
 *
 * 实测 37555 条真实记录：绝大多数只有 2—6 层，但 `session_meta` 里的
 * 工具 schema 能到 22 层（占 0.8%）。上限必须明显高于它，否则真实数据会被截断；
 * 同时又得有个上限，防止异常结构把递归拖到栈溢出。
 */
export const REDACTION_MAX_DEPTH = 40

/**
 * 命中报告里每条上下文最多多少字符。
 *
 * 比搜索片段的 SEARCH_SNIPPET_LENGTH 短：那边一屏只放一条，这边是一个按规则
 * 分组的列表，一屏要放下好几条才看得出「这条规则是不是误伤」。
 */
export const REDACTION_CONTEXT_LENGTH = 120

/**
 * 同一条规则最多留几条样例。
 *
 * 计数是精确的，被限制的只有样例。一条规则命中三百次时，看五条就够判断它是不是
 * 误伤，第六条起没有新信息 —— 而三百条打码片段要占的内存是实打实的。
 */
export const REDACTION_REPORT_MAX_SAMPLES = 5

/** 「被判为不是密钥」最多列几条。面板上一屏能读完的量。 */
export const REDACTION_REPORT_MAX_KEPT = 30

/**
 * 最多统计多少个不同的「键名 + 原因」组合。
 *
 * 超过就停止新增并置 keptTruncated —— 一个 JSON 里出现五百个不同的沾敏感词的
 * 键名时，这份报告本身已经没法读了，继续攒下去只是在占内存。
 */
export const REDACTION_REPORT_MAX_KEPT_KEYS = 500

/**
 * 敏感字段名。只要 JSON 的键名或文本中的标签命中这些词，其值就会被打码。
 * 规格明确要求的：API Key / Token / Password / Secret / Authorization / Cookie。
 */
export const SENSITIVE_KEY_WORDS: readonly string[] = [
  'api_key',
  'apikey',
  'api-key',
  'access_token',
  'refresh_token',
  'id_token',
  'auth_token',
  'authtoken',
  'token',
  'password',
  'passwd',
  'pwd',
  'secret',
  'client_secret',
  'authorization',
  'auth',
  'cookie',
  'set-cookie',
  'session_token',
  'private_key',
  'privatekey',
  'credential',
  'credentials',
  'passphrase',
  'openai_api_key',
  'anthropic_api_key'
]

export const DEFAULT_SETTINGS: AppSettings = {
  extraScanDirs: [],
  useBuiltinDirs: true,
  maxDepth: DEFAULT_MAX_DEPTH,
  maxFileSizeMb: DEFAULT_MAX_FILE_SIZE_MB,
  confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
  redactSensitive: true,
  showFullPaths: false,
  theme: 'dark',
  playbackIntervalMs: 1200,
  hiddenSources: [],
  hiddenSessionIds: [],
  // 单价默认留空 —— 我们不知道用户用的是哪档价格，猜一个填进去只会让金额看着
  // 像官方数字。留空时界面只显示 token 数。
  pricePerMillionInput: null,
  pricePerMillionOutput: null,
  priceCurrency: '',
  // 留空 = 跟随平台。默认模板依赖平台（Windows 的 cd 要 /d），
  // 而这里拿不到平台，所以真正的默认值在渲染进程里解析。
  resumeTemplate: '',
  // 默认建索引 —— 不建就搜不了全文，而全文搜索是这个功能的全部价值。
  // 关掉的理由只有一个：不想让这份文本落到磁盘上。
  buildSearchIndex: true
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeCommandOutput: true,
  includeRawJson: false,
  showFullPaths: false,
  redactSensitive: true
}

export interface EventTypeMeta {
  label: string
  /** 语义色板 key，渲染进程映射为具体样式。 */
  tone:
    | 'user'
    | 'assistant'
    | 'tool'
    | 'shell'
    | 'output'
    | 'file'
    | 'diff'
    | 'test'
    | 'error'
    | 'neutral'
    /** 刻意压低的灰调，用于思考过程这类\"可以不看\"的内容。 */
    | 'muted'
  /** lucide-react 图标名。 */
  icon: string
  /** 一句话解释，给不懂术语的用户看。 */
  hint: string
}

export const EVENT_TYPE_META: Record<CodexEventType, EventTypeMeta> = {
  session_start: {
    label: '会话开始',
    tone: 'neutral',
    icon: 'Flag',
    hint: '这次对话的起点，包含项目目录等基本信息。'
  },
  user_message: {
    label: '你说',
    tone: 'user',
    icon: 'MessageCircle',
    hint: '你向 Codex 提出的要求。'
  },
  assistant_message: {
    label: 'Codex 回复',
    tone: 'assistant',
    icon: 'Bot',
    hint: 'Codex 给你的回答或说明。'
  },
  reasoning: {
    label: '思考过程',
    tone: 'muted',
    icon: 'Brain',
    hint: 'Codex 在动手之前的内部推演，不是给你看的回答。默认折叠。'
  },
  tool_call: {
    label: '调用工具',
    tone: 'tool',
    icon: 'Wrench',
    hint: 'Codex 使用了某个内部工具来完成任务。'
  },
  shell_command: {
    label: '执行命令',
    tone: 'shell',
    icon: 'Terminal',
    hint: 'Codex 在你电脑上运行过的命令（本应用只展示，绝不重新执行）。'
  },
  command_output: {
    label: '命令输出',
    tone: 'output',
    icon: 'ScrollText',
    hint: '命令运行后打印出来的内容。'
  },
  file_read: {
    label: '读取文件',
    tone: 'file',
    icon: 'FileSearch',
    hint: 'Codex 查看了某个文件的内容。'
  },
  file_write: {
    label: '写入文件',
    tone: 'file',
    icon: 'FilePlus2',
    hint: 'Codex 新建或整体覆盖了某个文件。'
  },
  file_edit: {
    label: '修改文件',
    tone: 'file',
    icon: 'FilePen',
    hint: 'Codex 改动了文件中的部分内容。'
  },
  git_diff: {
    label: '代码差异',
    tone: 'diff',
    icon: 'GitCompare',
    hint: '一次代码前后对比。'
  },
  test_start: {
    label: '开始测试',
    tone: 'test',
    icon: 'FlaskConical',
    hint: 'Codex 开始运行测试来检验代码。'
  },
  test_result: {
    label: '测试结果',
    tone: 'test',
    icon: 'CircleCheckBig',
    hint: '测试通过、失败或被跳过的统计。'
  },
  error: {
    label: '出错了',
    tone: 'error',
    icon: 'CircleAlert',
    hint: '这一步没有成功，可以重点看这里。'
  },
  unknown: {
    label: '其他记录',
    tone: 'neutral',
    icon: 'CircleHelp',
    hint: '一条暂时无法归类的记录，原始内容已完整保留。'
  }
}

/** 用于"只看代码修改"过滤器。 */
export const CODE_CHANGE_EVENT_TYPES: readonly CodexEventType[] = [
  'file_write',
  'file_edit',
  'git_diff'
]

/** 默认不在时间线上显示的类型（可以在界面上打开）。 */
export const HIDDEN_BY_DEFAULT_EVENT_TYPES: readonly CodexEventType[] = ['reasoning']

/**
 * 纯噪音记录：只对 harness 自己有意义，对"我和 Codex 做了什么"毫无帮助。
 * 这些记录会被**整条丢弃**，不会变成事件。
 *
 * 判断依据是实测真实日志：一个会话里 5500 条事件中有 2896 条是这类记录，
 * 其中 item_completed 只是把已经出现过的 response_item 再播报一遍（纯重复），
 * token_count 是用量计数器。留着它们会让时间线彻底没法读。
 */
export const NOISE_RECORD_TYPES: readonly string[] = [
  // 已出现过的条目的 UI 回播，内容与前面的 response_item 完全重复
  'item_completed',
  'item_started',
  'item_updated',
  // 用量与计费统计
  'token_count',
  'token_usage',
  'usage',
  'rate_limits',
  // 任务/回合生命周期通知
  'task_started',
  'task_complete',
  'task_finished',
  'turn_started',
  'turn_complete',
  'turn_completed',
  // harness 内部状态
  'thread_settings_applied',
  'world_state',
  'inter_agent_communication_metadata',
  'stream_started',
  'stream_completed',
  'notification',
  'heartbeat',
  'ping',
  // 多智能体 harness 的活动播报：子智能体自己的会话另有文件记录，
  // 这里只是"某个子智能体动了一下"的通知，实测占了剩余噪音的六成。
  'sub_agent_activity',
  'agent_activity',
  'thread_goal_updated',
  'thread_name_updated',
  'thread_rolled_back',
  'thread_updated',
  // 上下文压缩通知：属于 harness 自己的内存管理，不回答"我和 Codex 做了什么"
  'compacted',
  'context_compacted',
  // 界面与网络层日志
  'ui',
  'browser',
  'http'
]

/**
 * 流式增量片段：最终的完整消息会另有一条记录，
 * 留着这些片段会把一条回复拆成几百条事件。
 */
export const DELTA_RECORD_PATTERN = /_delta$|^delta$/

/**
 * 判定「同一件事被记了两遍」的时间窗口。
 *
 * 两条并行的记录通道（给界面看的通知 vs 正式记录）写同一件事时时间戳几乎相同；
 * 而用户真的把同一句话说两遍，中间至少隔着 Codex 的一次回复。
 *
 * 实测 50 个真实会话里的同内容消息对：4280 对是镜像重复，时间差最大 2.44 秒；
 * 143 对是真实重复（多智能体互发的通知、摘要相同的多次改动），最小时间差 3.22 秒。
 * 3 秒正好落在这条清晰的分界线上。
 */
export const MIRROR_TIME_WINDOW_MS = 3000

/**
 * 镜像判定往前看的最大事件数。
 *
 * 真正的判据是时间窗口，这个上限只是防止极端文件（成千上万条同一秒的记录）
 * 把去重退化成 O(n²)。实测镜像的两条记录最远隔了 48 条事件。
 */
export const MIRROR_MAX_LOOKBACK = 200

/**
 * Codex 自己维护的会话名索引，位于 Codex 主目录下。
 * 每行形如 {"id":"…","thread_name":"构思 Codex 生态助力项目","updated_at":"…"}。
 */
export const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'

/** 会话名索引最多读这么多行，避免异常大的索引拖慢扫描。 */
export const MAX_SESSION_INDEX_LINES = 100_000

// ---------------------------------------------------------------------------
// 跨会话搜索
// ---------------------------------------------------------------------------

/** 倒排表落盘文件的格式版本。改了分词规则就得 +1，否则新老词条混在一张表里。 */
export const SEARCH_INDEX_VERSION = 1

/**
 * 倒排表体积预算。
 *
 * 现有 session-index.json 在 674 个会话下是 2.6 MB；全文倒排比它大一个量级是
 * 正常的，再大就该问用户还要不要建了。超预算的处理见 invertedIndex.trimToBudget。
 */
export const SEARCH_INDEX_BUDGET_BYTES = 30 * 1024 * 1024

/** 单个词条最长多少字符。更长的是哈希、base64、data URI —— 搜不到它们没有损失。 */
export const SEARCH_MAX_TERM_LENGTH = 48

/**
 * 纯数字词条最长多少位。
 *
 * 再长的是毫秒时间戳（13 位）和行号偏移，谁也不会去搜；但 2345、4004 这种
 * 错误码与端口号得留着。
 */
export const SEARCH_MAX_NUMERIC_LENGTH = 8

/** 单个字段进索引时最多取多少字符。一次 cat 大文件的输出可以是几 MB。 */
export const SEARCH_MAX_FIELD_LENGTH = 64 * 1024

/** 查询时一个词最多扩展成多少个词条。防止搜 "a" 把整张表拖出来。 */
export const SEARCH_MAX_EXPANSION = 64

/**
 * 子串扩展的最短查询词长度。比这个短的词只做前缀扩展。
 *
 * 三个字符这条线是被一次真实的误召回逼出来的：搜 `sk` 时子串扩展命中了
 * `desktop`（de-**sk**-top），于是"搜密钥搜不到"这条断言变成了"搜密钥能搜到那个
 * 会话"。两个字符的针在任何一张真实词表里都能扎到一堆词，而"最短的 64 个"这个
 * 截断会让命中结果看起来完全随机。
 *
 * 前缀扩展不设这条线：`以 sk 开头` 还能向用户解释，`中间某处有 sk` 不能。
 * 中文 bigram 恰好是两个字符，所以它们永远走不到子串这一层 —— 那正是想要的，
 * 第一层只负责粗筛，误召回该由第二层的精确匹配挡掉。
 */
export const SEARCH_MIN_SUBSTRING_LENGTH = 3

/** 第一层默认返回多少个候选会话。 */
export const SEARCH_DEFAULT_LIMIT = 50

/** 查询串长度上限。再长的查询没有意义，只会让词条扩展炸开。 */
export const SEARCH_MAX_QUERY_LENGTH = 200

/** 命中片段的长度上限。够看清一行代码或一句话，不够就点进去看。 */
export const SEARCH_SNIPPET_LENGTH = 160

/** 一个会话里最多返回多少处命中。命中几百处时步进器已经没有意义了。 */
export const SEARCH_MAX_HITS_PER_SESSION = 200

/**
 * 输入停下多久才发一次全文查询。
 *
 * 列表的本地过滤是**即时**的，这个延迟只压住 IPC 那一次往返 —— 打字的手感由本地
 * 过滤保证，200 ms 换来的是不给每一个按键都跑一遍倒排求交集。
 */
export const SEARCH_DEBOUNCE_MS = 200

/**
 * ASCII 侧至少打几个字符才发全文查询。
 *
 * 一个字母会前缀扩展出成百上千个词条，返回几乎整个库 —— 那看着像"搜索坏了"，
 * 而不是"这个字母确实到处都有"。中文不受这条限制：一个汉字的信息量足够，而且
 * 单字查询走的是精确匹配，不会扩展。
 */
export const SEARCH_MIN_ASCII_QUERY_LENGTH = 2

export const PRIVACY_POINTS: readonly string[] = [
  '所有会话文件都在你自己的电脑上读取，本应用不会上传任何内容。',
  '本应用不调用任何 AI 接口、云端服务、遥测或错误上报服务。',
  '不需要登录、注册、账号或 API Key；断网后功能完整可用。',
  '渲染界面被禁止访问网络，所有网络请求在应用内部被直接拦截。',
  '只读取 Codex 会话文件，从不修改、移动或删除它们。',
  '默认只扫描已知的 Codex 目录，不会扫描整个硬盘。',
  '会话日志里的命令只会被展示，绝不会被重新执行。',
  '密钥、Token、密码等敏感字段默认自动打码。',
  '全文搜索索引只建在打码之后的文本上：密钥不会被写进索引，代价是也搜不到它们。',
  '索引（会话摘要与全文搜索索引）和设置只保存在你本机的应用数据目录中，卸载后可自行删除。'
]
