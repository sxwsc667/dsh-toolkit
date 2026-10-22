import { randomUUID } from 'node:crypto'
import { stat, mkdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'

/**
 * 插件在配置加载器里的稳定标识，也是 cordis.patch.yml 里插入那一行的对照物。
 */
export const name = 'tool-handoff-session'

/**
 * 本插件依赖的宿主服务：
 * - tools（工具登记表）：用来登记对模型可见的工具。
 * - sessionController（会话控制器）：用来创建新会话、投递第一条消息。
 * - workspaceRegistry（工作区注册表）：用来按标题查找工作区、按路径登记工作区。
 *
 * 每个 Agent 会话都带着自己的模式（agent preset），所以这里用 `agentPresets` 读取可选模式。
 * 该服务在极少数精简部署里可能不存在，插件改成运行时可选读取，不让它卡住激活。
 */
export const inject = ['tools', 'sessionController', 'workspaceRegistry']

/**
 * 工具名，只在按模式隐藏时按名字引用。
 */
const TOOL_NAME = 'new_work'

/**
 * 极简模式（minimal）只留一个人设和一条命令行，不承担交接这件事。
 * 工具登记是全局的、默认所有会话都可见，所以要在会话创建时按模式收窄：
 * 除了极简模式，其他模式都保留 new_work。
 */
const MINIMAL_PRESET_ID = 'minimal'

/**
 * 从交接内容里取一段“能当标题用”的开头，供用户在自己的会话列表里认出这个新会话。
 *
 * 客户端会话列表的每一行显示的是会话标题，而标题是宿主从第一条用户消息派生的。
 * 这里给的是同源的确定性近似值（开头若干字），所以对外措辞一律用“大致是”，
 * 不假装它就是最终标题——真正的标题可能由模型重新生成成别的句子。
 *
 * @param handoff 交接内容原文。
 * @returns {string} 压平空白后的开头一段；没有可用文字时返回空串。
 */
function headlineOf(handoff) {
  if (typeof handoff !== 'string') return ''
  const flat = handoff.replace(/\s+/g, ' ').trim()
  if (flat.length === 0) return ''
  return flat.length > 18 ? `${flat.slice(0, 18)}…` : flat
}

/**
 * 拼出交给新会话的内容：先接上自己最后对用户说的那段话，再放交接原文。
 *
 * 2026-10-22 晚第三次改版，按用户意见把开场白整个拿掉。
 * 用户的原话：最好的转交方法不是告诉他什么不能做，而是让他根本不知道——
 * 要让新诞生的对话感觉自己就是老对话自然延续下来的，而不是由别人拉起来的。
 * 前两版都在正文里反复解释“这段文字是谁写的、你不该把它当成什么”，
 * 结果新会话的注意力全被引到“这段材料”上，真实调用时第一句常常变成对交接本身的评点。
 * 现在一个字的解释都不写：上一轮最后说的话接上留下的记录，读起来就是同一段思路在往下走。
 *
 * 位置和模式也不再开口交代：新会话的目录、说明文件、工具集本来就会告诉它这些，
 * 特意写一句“你已经换了个身份过去”等于提醒它自己是被搬过来的，正好破坏连续性。
 *
 * @param {object} relay 交接所需的来历信息。
 * @param {string} relay.handoff 交接原文。
 * @param {string | undefined} relay.lastReply 本会话最后一段有文字的助手发言；拿不到时为空。
 * @returns {Array<{type: 'text', text: string}>} 模型可见的内容块：接话与交接原文。
 */
function buildRelayContent({ handoff, lastReply }) {
  const blocks = []
  if (typeof lastReply === 'string' && lastReply.length > 0) {
    blocks.push({ type: 'text', text: lastReply })
  }
  blocks.push({ type: 'text', text: handoff })
  return blocks
}

/**
 * 取当前会话里最后一段有文字的助手发言，作为新会话的接话。
 *
 * 工具是在助手回合中间执行的：这一步的文字通常已经落进会话记录，正是新会话该看到的前言。
 * 拿不到（部署不同、会话对象形状不同）就老实不补——绝不能编一段话冒充自己说过。
 *
 * @param exec 工具执行上下文。
 * @returns {string | undefined} 压平空白后的发言文本；没有可用文字时返回 undefined。
 */
function readLastReply(exec) {
  try {
    const session = exec === null || exec === undefined ? undefined : exec.agent?.session
    if (session === undefined || typeof session.deriveMessages !== 'function') return undefined
    const messages = session.deriveMessages()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message === undefined || message.role !== 'assistant') continue
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim()
      if (text.length > 0) return text
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 造一条“相邻会话转达”的 user 角色消息。
 *
 * 来源用宿主自己的 `agent-message` 类型（子代理给父代理发消息用的就是它），
 * `form: 'relay'` 表示转达。这样它在界面上和日志里都不是“用户发言”。
 * 模型看不到这层元数据，正文里也不再写任何来源说明——那正是第三版删掉的东西；
 * 这里只负责让这条消息在宿主那边归类正确，不负责讲来龙去脉。
 * 消息编号由这里生成，形状与宿主的 createUserMessage 一致。
 *
 * @param senderSessionId 发起交接的会话编号。
 * @param content         模型可见的内容块。
 * @returns {object} 可交给 agent.followup 投递的消息对象。
 */
function createRelayMessage(senderSessionId, content) {
  return {
    id: randomUUID(),
    role: 'user',
    content,
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
  }
}

/**
 * 从一个工作区的说明文件里抽出“这个工作区是什么身份”的一行摘要。
 *
 * 照技能文件的渐进式加载来分两层：开头一段是「描述」，用来让调用方在选地方时快速判断；
 * 正文是「内容」，只有新会话真进到这个目录后才会被整份读进去。所以这里只取描述，不取正文。
 *
 * 描述优先从文件顶部的 `---` 元信息里取 `description:`（与技能文件同一写法）；
 * 没有元信息时，退回取开头的标题和紧随其后的第一句。
 *
 * @param text 说明文件的原始正文。
 * @returns {string | undefined} 一行摘要；正文里没有可用内容时返回 undefined。
 */
function summarizeIdentity(text) {
  const cleaned = text.replace(/<!--[\s\S]*?-->/g, '')
  // 元信息块必须是文件最开头的那一段，避免把正文里的分隔线误当成元信息。
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(cleaned)
  if (frontMatter !== null) {
    const declared = /^description:\s*(.+)$/m.exec(frontMatter[1])
    if (declared !== null) {
      const summary = declared[1].trim().replace(/^["']|["']$/g, '')
      if (summary.length > 0) return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary
    }
  }

  const lines = cleaned
    .split(/\r?\n/)
    // 去掉列表符号、引用符号和行内标记：这是要嵌进一句话里的摘要，不该带排版符。
    .map((line) => line.trim().replace(/^[>#*+-]+\s*/, '').replace(/\*\*/g, '').replace(/`/g, '').trim())
    .filter((line) => line.length > 0)
  if (lines.length === 0) return undefined
  const title = lines[0]
  const body = lines.slice(1).find((line) => !line.startsWith('|') && !line.startsWith('```'))
  // 只保留第一句：整段规矩留给新会话自己去读。
  const sentence = body === undefined ? undefined : body.split(/[。！？.!?]/)[0]
  const summary = sentence === undefined || sentence.length === 0 ? title : `${title}：${sentence}`
  return summary.length > 120 ? `${summary.slice(0, 117)}…` : summary
}

/**
 * 扫描每个工作区目录的说明文件，把“这个工作区是什么身份”记进缓存。
 *
 * 说明文件沿用 DSH 自己的约定（AGENTS.md，其次 CLAUDE.md）：新会话进到那个目录后，
 * 宿主会把同一份文件当规矩读给模型，所以这里取的首段正好和那边的实际行事对得上。
 * 扫描是异步的、按文件修改时间跳过没变的，节流到每 30 秒最多一次。
 *
 * @param {object} identityCache 身份摘要缓存：path → { mtimeMs, summary }。
 * @param {Array<{path: string}>} workspaces 当前登记的工作区。
 * @returns {void} 无返回值；扫描结果异步写进缓存。
 */
function ensureIdentities(identityCache, workspaces) {
  const now = Date.now()
  if (now - identityCache.lastScanAt < 30_000) return
  identityCache.lastScanAt = now

  for (const workspace of workspaces) {
    const directory = workspace.path
    void (async () => {
      for (const fileName of ['AGENTS.md', 'CLAUDE.md']) {
        const filePath = join(directory, fileName)
        const info = await stat(filePath).catch(() => undefined)
        if (info === undefined || !info.isFile()) continue
        const known = identityCache.byPath.get(directory)
        if (known !== undefined && known.mtimeMs === info.mtimeMs) return
        const text = await readFile(filePath, 'utf8').catch(() => undefined)
        if (text === undefined) return
        identityCache.byPath.set(directory, { mtimeMs: info.mtimeMs, summary: summarizeIdentity(text) })
        return
      }
      // 两个候选文件都没有：清掉旧摘要，免得目录改名或换用途后还显示着过期身份。
      identityCache.byPath.delete(directory)
    })()
  }
}

/**
 * 把工作区列表渲染成给人看的清单：标题、路径，以及那个目录自己的身份摘要。
 *
 * @param ctx           宿主上下文，用来读取当前登记的工作区。
 * @param identityCache 身份摘要缓存。
 * @returns {string} 一段可直接放进工具描述的清单文本，任何失败都降级成一句说明。
 */
function renderWorkspaces(ctx, identityCache) {
  try {
    const workspaces = ctx.workspaceRegistry.list()
    if (workspaces.length === 0) {
      return '当前没有任何已登记的工作区；不填 workspace 就沿用当前会话自己的目录。'
    }
    ensureIdentities(identityCache, workspaces)
    const lines = workspaces.map((workspace) => {
      const summary = identityCache.byPath.get(workspace.path)?.summary
      // 没写说明的工作区也要明说：让用户一眼看出该去那个目录补一份 AGENTS.md。
      const tail =
        summary === undefined ? '——这个工作区的身份：还没写（该目录下没有 AGENTS.md）' : `——这个工作区的身份：${summary}`
      return `- ${workspace.title}（${workspace.path}）${tail}`
    })
    return ['当前已登记的工作区——每个工作区就是一个身份，也就是“以什么身份、面对什么事”（workspace 参数填下面的标题或目录路径）：', ...lines].join('\n')
  } catch (error) {
    return `（读取工作区列表失败：${String(error)}）`
  }
}

/**
 * 官方内置模式自带的说明。上游那四个预设只在声明里写了 id 和排序，没写用途说明，
 * 用户在界面或工具描述里看不到它们之间的差别。插件在这里补上，装完即用、不需要用户改配置。
 *
 * 说明按各预设实际的插件清单归纳：minimal 只有人设和终端；standard、ptc、cordis 是同一套
 * 完整工具集，ptc 的区别是工具以代码方式批量调用，cordis 的区别是多带 Cordis 插件开发工具与技能。
 */
const BUILTIN_PRESET_DESCRIPTIONS = {
  standard: '标准模式：完整工具集——读写文件、跑命令、搜索、子代理、工作流、计划模式、待办、联网，一次调一个工具。日常干活用它。',
  ptc: '批量调用模式：工具集和标准模式一样，但工具要通过写一段程序来批量调用，而不是一个个叫。适合一次要动很多文件的重复操作。',
  cordis: '框架开发模式：在标准模式基础上多了 Cordis 插件与组合的开发工具和技能，用来编写、调试 DSH 自己的插件和预设组合。',
  minimal: '最精简模式：只有一个人设和一个终端，没有文件读写、搜索、子代理这些工具，只能跑命令。适合只想执行几条命令的场景。',
}

/**
 * 把可选模式渲染成给人看的清单：模式 id、显示名、用途说明，缺说明时如实指出。
 *
 * @param cache 模式列表的缓存，未读取完成时是 undefined。
 * @returns {string} 一段可直接放进工具描述的清单文本。
 */
function renderPresets(cache) {
  if (cache.rows === undefined) {
    return '（模式列表尚未读取到；preset 参数请填模式 id，留空则用部署默认模式。）'
  }
  if (cache.rows.length === 0) {
    return '当前部署没有可选模式；preset 参数留空即可。'
  }
  const lines = cache.rows.map((preset) => {
    const label = preset.name === undefined || preset.name === preset.id ? preset.id : `${preset.id}（${preset.name}）`
    const mark = preset.id === cache.defaultId ? '，默认' : ''
    // 模式自己写了说明就用它；没写就用插件内置的官方说明；两者都没有才如实说没写。
    const declared = preset.description === undefined ? '' : preset.description.trim()
    const purpose = declared.length > 0 ? declared : BUILTIN_PRESET_DESCRIPTIONS[preset.id]
    const tail =
      purpose === undefined || purpose.length === 0 ? '：（该模式没有写说明）' : `：${purpose}`
    const broken = preset.broken === undefined ? '' : `（当前不可用：${preset.broken}）`
    return `- ${label}${mark}${tail}${broken}`
  })
  return ['可选状态（preset 参数填左侧的 id，也就是挑当下用什么劲头做事）：', ...lines].join('\n')
}

/**
 * 读一次模式列表并缓存。服务可能晚于本插件就绪，所以调用方每次渲染前都可以安全地调它：
 * 还没读到结果就尝试一次，读到了就直接用缓存；并发调用不会重复发起读取。
 *
 * @param ctx   宿主上下文。
 * @param cache 模式列表缓存：rows 是读到结果后的清单，loading 是“正在读”的标记。
 * @returns {void} 无返回值；读取结果异步写进缓存。
 */
function ensurePresets(ctx, cache) {
  if (cache.rows !== undefined || cache.loading) return
  // 用 ctx.get 而不是 ctx.agentPresets：模式注册表是异步初始化的服务，插件激活那一刻它
  // 可能还没就绪，直接读属性会抛错并让整个插件加载失败；ctx.get 在未就绪时安静地返回 undefined。
  const service = ctx.get('agentPresets')
  // 已声明但还没赋值的服务会给出一个没有 list 的占位对象，这种也要跳过、等下一轮再试。
  if (service === undefined || typeof service.list !== 'function') return
  cache.loading = true
  cache.defaultId = service.defaultId
  Promise.resolve(service.list())
    .then((rows) => {
      cache.rows = Array.isArray(rows) ? rows : []
    })
    .catch(() => {
      // 读取失败不缓存结果，让下一次渲染有机会重试。
    })
    .finally(() => {
      cache.loading = false
    })
}

/**
 * 组装完整的工具描述。每次读描述都重新渲染一遍，因为用户随时可能新建或删除工作区、
 * 开关某个模式；把清单写死会让模型照着过期名单去切。
 *
 * @param ctx   宿主上下文。
 * @param cache 模式列表缓存。
 * @returns {string} 交给模型看的工具说明。
 */
function describeTool(ctx, cache, identityCache) {
  ensurePresets(ctx, cache)
  return [
    '换一个身份或状态继续干活：开一个新会话，把交接内容作为它收到的第一条消息，让它在新的身份或新的状态下接着做。',
    '',
    '这是你在当前对话里要做的最后一件事，像按下暂停键：按下之后，焦点就转到新会话，',
    '用户不会再回来看这边，你现有的对话就此停摆。',
    '所以调用之前把该交代的全部交代清楚；调用之后这一轮的回复只陈述已经发生的事，',
    '不要接着分析、总结、规划，也不要再动文件或开新会话。',
    '',
    '先把两个词说清楚，别按字面当成“职位头衔”和“软件参数”：',
    '',
    '「身份」不是名字、职称那种传统身份，而是“面对什么事、以什么身份说话”。',
    '同一个人，回到家是以父亲的身份面对孩子的教育，到单位是以员工的身份面对手上的工作：',
    '事情一换，立场、能拍板什么、该守什么规矩都跟着换。',
    '在这个工具里，一个工作区就是一个身份——那个目录下的说明文件（AGENTS.md）写明了它是什么身份、照什么规矩办事；',
    '所以换工作区，本质上是换一个人、换一副立场去面对另一件事。',
    '',
    '「状态」（preset 参数）也不是软件里说的“模式”，而是这个身份当下处在什么劲头上。',
    '就像人干活：一开始可能有点懒散、随便应付；出了岔子，心里暗道“这不行，我得认真起来了”，',
    '然后整个人沉下来，进入深度思考——还是同一个人、同一件事，只是劲头不一样。',
    '所以换状态不换地方：工作区不变，只是把接下来那段活儿换一种投入程度去做。',
    '',
    '什么时候用：当下一步不该由现在这个身份、或现在这个状态继续做时。有两种切法——',
    '',
    '一、只换状态（同一件事、同一个身份，只是换一种劲头）。',
    '比如刚聊完、心还散着，接下来要动真格改代码了，就把状态拧到专心干活那一档：',
    '不填 workspace，只把 preset 换成对应的那个，新会话仍在这个工作区里、仍是这个身份。',
    '',
    '二、换身份（下一步该由另一个身份去面对那件事）。',
    '比如这件事从“陪我聊想法”变成了“去批改学生作业、给家长写反馈”，那就该由老师那个身份来做。',
    '这时填 workspace，指定那个身份所在的那个工作区。',
    '',
    '所以：不填 workspace 就等于“在当前工作区开个新对话”，只换状态不换地方；',
    '填了 workspace 才是“换身份，去另一个工作区”。',
    '',
    '反过来：现在这个身份、这个状态就能把这件事做好时，不要切；新会话是另起炉灶，不是顺手用一下。',
    '',
    '怎么选模式（也就是换哪种劲头）：先看下面状态清单，挑出对得上这段活劲头的那个 preset；',
    '要换身份，就看工作区清单里每个工作区的「身份」——它写的是那个身份面对什么事情、照什么规矩办事，',
    '挑出对得上的那个，用它的标题或路径作为 workspace。',
    '',
    '转过去之后，新会话以那个工作区的身份行事，按那个目录说明文件里的规矩来；它代表的是那个身份，不是这里。',
    '新会话创建后会自动开始执行，不需要用户再手动发消息。',
    '',
    '交接内容写什么：这里传入的 handoff 是你留给接班人的全部家底，像留遗嘱一样写，不是写文档。',
    '它是一次性的：只对这一个新的新会话有效，说清“我干到哪了、你现在先做哪一件、有哪些临时的决定和坑”就够了。',
    '长期有效的东西——这个身份是干什么的、项目怎么组织、有哪些规矩——不要往这里塞：',
    '那些该写进工作区目录的 AGENTS.md，新会话一进去就会读到，在这里重复只是浪费。',
    '判断标准很简单：这条信息以后别的人也要知道，就写进文档；只有眼下这一次需要，就放在 handoff 里。',
    '',
    '调这个工具之前，先把这一边的账结清：凡是还欠用户的，一个不剩地搬进 handoff——',
    '要用户拍板的选择、你本来准备问“要不要我改 X”的那类问句、没做完的步骤、你发现但还没处理的毛病，全都算。',
    '理由：交接之后用户就跟着新会话走了；你在这边再问、再说，用户很可能已经切过去、不会再回来答。',
    '所以 handoff 里要写明两样东西：下一步第一件事是什么，以及有哪些事需要用户点头。',
    '',
    '调用成功之后，这一轮的回复里不要再留任何问题或待办：',
    '不要问“要不要我把 X 也改了”，也不要许诺“我接下来去做 Y”。',
    '这些已经跟着交接进了新会话，该由新会话说、新会话做。你这边只陈述已经发生了什么。',
    '',
    '交接之后这件事就归新会话了，你不跟它并行干同一件事：不要回头去读它的消息、日志或运行结果，',
    '也不要等它汇报。new_work 是交接班，不是派一个侦察兵回来向你汇报。',
    '需要核对、需要验收什么，写进 handoff 让它自己核对——那已经是它的活了。',
    '',
    renderWorkspaces(ctx, identityCache),
    '',
    renderPresets(cache),
    '',
    '换状态实际换的是什么：模式决定新会话开局带哪些工具和提示词，会话建好后就不能再改。',
    '所以挑的时候先问“下一段活需要什么劲头”：要连着推进很多步、得较真，就选能力更全的那个；',
    '只是问一句话，选轻的那个，别扛着整套工具去散步。',
    '',
    '交接内容怎么进到新会话：插件会把它接在你这一轮对用户说的话后面，作为新会话的第一条消息，',
    '中间不插任何“这是交接、这是别人转达”的说明——新会话读起来就是自己的思路在往下走。',
    '所以 handoff 要用第一人称接着写：我现在干到哪、下一步先做哪一件、有哪些临时的决定和坑；',
    '写成给别人派活的任务书、或者解释“这段文字从哪来”，新会话就会开始处理材料，而不是接着干活。',
    '新会话建好后会自己开始执行；用户想去看就自己切过去，不需要你额外提醒。',
  ].join('\n')
}

/**
 * 从宿主取新会话自己的 agent（智能体运行时对象），用来把交接内容送进去。
 *
 * 用 ctx.get 而不是 ctx.agents：服务没就绪时前者安静地返回 undefined，
 * 不会像直接读属性那样抛错把整个插件拖挂。
 *
 * @param ctx       宿主上下文。
 * @param sessionId 新会话编号。
 * @returns {object | undefined} 命中的 agent；服务缺失或会话未注册时返回 undefined。
 */
function readAgent(ctx, sessionId) {
  try {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
    if (agents === undefined || typeof agents.get !== 'function') return undefined
    return agents.get(sessionId)
  } catch {
    return undefined
  }
}

/**
 * 给新会话起一个标题，让用户在会话列表里一眼认出来。
 *
 * 交接内容不再伪装成用户发言，标题也就不会由它自动生成，所以这里显式给一个。
 * 标题只是方便认人：失败不影响交接本身，静默跳过。
 *
 * @param ctx       宿主上下文。
 * @param sessionId 新会话编号。
 * @param title     标题文本；空串表示不起名。
 * @returns {Promise<void>} 起名结果不影响返回值。
 */
async function renameNewSession(ctx, sessionId, title) {
  if (title.length === 0 || typeof ctx.sessionController.rename !== 'function') return
  try {
    await ctx.sessionController.rename({ sessionId, title })
  } catch {
    // 标题服务在少数部署里不存在，或标题超长被拒；都不该让交接失败。
  }
}

/**
 * 把“工作区参数”解析成新会话的落地位置。
 *
 * 参数允许两种写法：已有工作区的标题（例如“我的项目”），或者一个目录的路径。
 * 解析顺序是先当标题查，查不到再当路径处理；这样用户不必记住当初登记时用的是哪种写法。
 *
 * @param ctx               宿主上下文，用来调用工作区注册表。
 * @param raw               模型传入的工作区参数，可能是标题、路径或空。
 * @param currentDirectory  当前会话自己的工作目录，参数为空时沿用它。
 * @returns {Promise<{ workspace?: object, cwd: string }>} 命中的工作区（可能为空）与最终的目录。
 * @throws 当参数既不是已知标题、又无法当成目录处理时，错误信息里附上可选的工作区清单。
 */
async function resolveTargetLocation(ctx, raw, currentDirectory) {
  if (raw === undefined || raw.trim().length === 0) {
    // 不指定位置时沿用当前目录；如果那个目录已经登记成工作区，就按工作区建会话，
    // 这样新会话会挂在同一个工作区分组下，而不是变成一个游离的会话。
    const current = await ctx.workspaceRegistry.resolveByPath(currentDirectory).catch(() => undefined)
    return current === undefined ? { cwd: currentDirectory } : { workspace: current, cwd: current.path }
  }
  const wanted = raw.trim()

  // 先按标题找已有工作区：标题是给人看的名字，重复标题取第一个。
  const byTitle = ctx.workspaceRegistry.list().find((workspace) => workspace.title === wanted)
  if (byTitle !== undefined) {
    return { workspace: byTitle, cwd: byTitle.path }
  }

  // 再按目录路径处理：相对路径按当前会话目录展开，目录不存在就先建出来，
  // 因为工作区注册表只接受已存在的目录。
  const absolute = isAbsolute(wanted) ? wanted : resolvePath(currentDirectory, wanted)
  const existed = await stat(absolute).then(
    (info) => info.isDirectory(),
    () => false,
  )
  if (!existed) {
    try {
      await mkdir(absolute, { recursive: true })
    } catch (error) {
      throw new Error(
        `既没有标题为「${wanted}」的工作区，也无法把它当成目录创建（${String(error)}）。\n${renderWorkspaces(ctx)}`,
      )
    }
  }

  const existing = await ctx.workspaceRegistry.resolveByPath(absolute)
  if (existing !== undefined) {
    return { workspace: existing, cwd: existing.path }
  }
  const created = await ctx.workspaceRegistry.create(absolute)
  return { workspace: created, cwd: created.path }
}

/**
 * 登记 new_work（把当前工作交接给指定工作区里的新会话）。
 *
 * @param {object} ctx 宿主上下文，携带 tools（工具登记表）、sessionController（会话控制器）、
 *                     workspaceRegistry（工作区注册表）三个服务。
 * @returns {void} 无返回值；副作用是向工具登记表登记一个工具，插件卸载时由宿主自动撤销。
 */
export function apply(ctx) {
  // 模式列表是异步读出来的，先占位、读到后填充；描述每次渲染都会重新取用它。
  const presetCache = { rows: undefined, defaultId: undefined, loading: false }
  // 工作区身份摘要：每个目录的说明文件开头一行，按修改时间缓存、节流扫描。
  const identityCache = { byPath: new Map(), lastScanAt: 0 }

  // 首选路径：等 `agentPresets` 服务就绪再读，这样第一次渲染通常就有清单。
  // 该服务属于 Web 层，少数精简部署里没有，缺失时静默跳过、由渲染时的兜底逻辑处理。
  ensurePresets(ctx, presetCache)
  ctx.inject(['agentPresets'], (scoped) => {
    ensurePresets(scoped, presetCache)
  })

  // 工具登记是全局的，所有会话默认都能看见。极简模式不该有交接：
  // 会话创建时按它自己的模式收窄一次，把 new_work 摘掉；其他模式不受影响。
  // 模式记在会话头里（agent.session.header.agentPreset），是持久字段，resume 后也还在。
  ctx.on('agent/created', ({ agent }) => {
    const presetId = agent?.session?.header?.agentPreset ?? agent?.agentPreset
    if (presetId !== MINIMAL_PRESET_ID) return
    try {
      agent.ctx.tools.restrict({ deny: [TOOL_NAME] })
    } catch {
      // 收窄失败就让工具照常可见：不能为了藏一个工具而让会话创建失败。
    }
  })

  ctx.tools.register({
    name: TOOL_NAME,
    // 用取值器而不是固定字符串：模型每轮读工具描述时都能看到最新的工作区和模式清单。
    get description() {
      return describeTool(ctx, presetCache, identityCache)
    },
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['handoff'],
      properties: {
        handoff: {
          type: 'string',
          minLength: 1,
          description:
            '交接班的一通嘱咐，像留遗嘱一样：这是你留给接班人的全部家底，写完就收手。' +
            '它会接在你这一轮对用户说的话后面，作为新会话的第一条消息，中间不插任何说明。' +
            '所以用第一人称接着写（“我干到哪了、下一步先做哪一件、有哪些临时的决定和坑”），' +
            '读起来就像同一段思路在往下走；写成给别人派活的任务书，或者解释“这段文字从哪来”，都会把连续性打断。' +
            '凡是还欠用户的东西都要写进来：需要他拍板的选择、没做完的步骤、你原本打算问的问题。' +
            '交接之后用户就跟着新会话走了，这一轮再问也没人答。' +
            '这不是写文档：长期有效的东西（身份、项目结构、规矩）应该落在工作区目录的 AGENTS.md 里，新会话会自己读到，写在这里只是重复。',
        },
        workspace: {
          type: 'string',
          description:
            '目标工作区。不填就留在当前工作区开新对话（只换状态）；填了就切到那个工作区（换身份）。' +
            '取值可以是工具描述里列出的工作区标题，也可以是一个目录路径。',
        },
        preset: {
          type: 'string',
          description:
            '新会话的状态（模式 id），取值见工具描述里的模式清单。不填 workspace 换状态时，这个就是“下一步进入什么状态”，应当填；' +
            '不填则用部署默认模式。',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId', 'directory'],
        properties: {
          sessionId: { type: 'string' },
          directory: { type: 'string' },
          preset: { type: 'string' },
          workspaceTitle: { type: 'string' },
        },
      },
      render: (args, value) => {
        const where =
          value.workspaceTitle === undefined
            ? `目录 ${value.directory}`
            : `『${value.workspaceTitle}』工作区（${value.directory}）`
        const headline = headlineOf(args?.handoff)
        const title = headline.length === 0 ? '' : `，标题是「${headline}」`
        return [
          {
            type: 'text',
            text:
              `已在${where}开好新会话${title}` +
              (value.preset === undefined ? '' : `，模式 ${value.preset}`) +
              '，交接内容已经接在你这一轮的话后面送过去了（不是用户消息），那边会立即开始执行。' +
              '用户要接着看会自己切过去，不需要你提醒。',
          },
        ]
      },
    },
    async execute(args, exec) {
      const handoff = args.handoff.trim()
      if (handoff.length === 0) {
        throw new Error('new_work 需要非空的交接内容')
      }
      if (exec.agent === undefined) {
        throw new Error('new_work 必须由某个会话发起')
      }
      const currentDirectory = exec.agent.session.header.cwd
      if (currentDirectory === undefined) {
        throw new Error('new_work 需要当前会话有工作目录')
      }

      const location = await resolveTargetLocation(ctx, args.workspace, currentDirectory)
      const presetId = args.preset === undefined ? undefined : args.preset.trim()
      const wantedPreset = presetId === undefined || presetId.length === 0 ? undefined : presetId

      // workspaceId 与 cwd 在 sessionController.create 里互斥：命中已有工作区时只传前者，
      // 否则只传后者，让会话目录与工作区记录保持一致。
      let created
      try {
        created = await ctx.sessionController.create({
          ...(location.workspace === undefined
            ? { cwd: location.cwd }
            : { workspaceId: location.workspace.id }),
          ...(wantedPreset === undefined ? {} : { agentPreset: wantedPreset }),
        })
      } catch (error) {
        const detail = String(error?.message ?? error)
        // 模式写错是调用方最常见的失误，直接把现有可选模式列出来，别让它去猜。
        if (wantedPreset !== undefined && /preset|模式/i.test(detail)) {
          throw new Error(`模式「${wantedPreset}」用不了：${detail}\n${renderPresets(presetCache)}`)
        }
        throw error
      }

      // 交接内容不按“用户消息”投递：先用标题让新会话在列表里认得出来，
      // 再通过新会话自己的 agent 接口把内容送进去。正文不带任何说明，接着上一轮的发言往下写。
      const senderSessionId = exec.agent.id ?? exec.agent.session.id
      const relayContent = buildRelayContent({ handoff, lastReply: readLastReply(exec) })

      await renameNewSession(ctx, created.sessionId, headlineOf(handoff))

      const agent = readAgent(ctx, created.sessionId)
      if (agent !== undefined && typeof agent.followup === 'function') {
        agent.followup(createRelayMessage(senderSessionId, relayContent))
      } else {
        // 兜底：极少数部署里拿不到新会话的 agent，退回会话控制器的投递通道。
        // 正文与首选路径一致（接话 + 交接原文），不带任何“这是交接”的说明。
        // 第二个参数是中止信号，宿主内部会调它的 throwIfAborted() 检查取消，漏传会直接抛错。
        await ctx.sessionController.prompt(
          {
            sessionId: created.sessionId,
            requestId: randomUUID(),
            mode: 'queue',
            content: [{ type: 'text', text: relayContent.map((part) => part.text).join('\n\n') }],
          },
          exec.signal,
        )
      }

      return {
        sessionId: created.sessionId,
        directory: location.cwd,
        ...(created.agentPreset === undefined ? {} : { preset: created.agentPreset }),
        ...(location.workspace === undefined ? {} : { workspaceTitle: location.workspace.title }),
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '新工作',
      kind: 'other',
      rawInput: args.workspace === undefined ? args.handoff : `${args.workspace}: ${args.handoff}`,
    }),
  })
}
