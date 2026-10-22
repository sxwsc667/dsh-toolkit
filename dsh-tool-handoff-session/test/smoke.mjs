// 插件逻辑自测：用一个假的宿主上下文调用 apply，检查工具描述、参数解析与执行分支。
// 不接触真实宿主，只验证参数解析、目录处理、动态描述，以及传给会话控制器/工作区注册表的入参。
import { mkdtemp, rm, stat, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply } from '../index.js'

/** 搭一个最小可用的假宿主：记录调用，按预设返回结果。 */
function makeContext(options = {}) {
  const record = {
    created: [],
    prompted: [],
    followed: [],
    renamed: [],
    registered: undefined,
    // 每个新会话在创建时就登记一个假 agent：真宿主里 create 返回后 agent 已经在注册表里了。
    agents: new Map(),
    // 让某个用例能模拟“拿不到新会话的 agent”，以便验证兜底投递路径。
    hideAgents: false,
    // 宿主事件监听器：按事件名收集，测试里手动派发。
    listeners: {},
  }
  const knownWorkspaces = options.workspaces ?? []
  const ctx = {
    tools: { register: (definition) => { record.registered = definition } },
    // 真实宿主里事件监听挂在 ctx.on 上；这里只记录，测试里手动派发。
    on: (event, listener) => {
      record.listeners[event] = [...(record.listeners[event] ?? []), listener]
      return () => {}
    },
    inject: (_deps, callback) => { callback(ctx) },
    get: (name) => ctx[name],
    agents: {
      get: (sessionId) => (record.hideAgents ? undefined : record.agents.get(sessionId)),
    },
    workspaceRegistry: {
      list: () => knownWorkspaces,
      resolveByPath: async (path) => knownWorkspaces.find((workspace) => workspace.path === path),
      create: async (path) => {
        const workspace = { id: `ws-${knownWorkspaces.length + 1}`, path, title: path }
        knownWorkspaces.push(workspace)
        return workspace
      },
    },
    sessionController: {
      create: async (request) => {
        record.created.push(request)
        const sessionId = `session-${record.created.length}`
        record.agents.set(sessionId, {
          id: sessionId,
          followup: (message) => { record.followed.push({ sessionId, message }) },
        })
        return {
          sessionId,
          ...(request.agentPreset === undefined ? {} : { agentPreset: request.agentPreset }),
        }
      },
      prompt: async (request, signal) => {
        record.prompted.push(request)
        // 真实宿主里第二个参数是中止信号，漏传会直接让宿主抛 throwIfAborted 相关错误。
        record.promptSignal = signal
        return { accepted: true }
      },
      rename: async (request) => {
        record.renamed.push(request)
        return { title: request.title, seq: 0 }
      },
    },
    agentPresets: {
      defaultId: 'standard',
      list: async () => [
        { id: 'standard', name: '标准模式', description: '完整能力的默认模式。' },
        { id: 'planning', name: '协作模式', description: '轻量版标准模式。' },
        { id: 'ptc' },
        { id: 'bare' },
      ],
    },
  }
  return { ctx, record }
}

/** 造一个 owning agent，形状与工具执行时的 exec.agent 一致；messages 用来模拟会话已有的消息。 */
function makeExec(cwd, messages = []) {
  return {
    agent: {
      id: 'session-parent',
      session: { header: { cwd }, deriveMessages: () => messages },
    },
    signal: new AbortController().signal,
  }
}

/** 让 apply 里异步读取模式列表的那一步有机会完成。 */
const settle = () => new Promise((done) => setTimeout(done, 0))

/** 取一次工具描述；取值器每次都会重新渲染。 */
const readDescription = (definition) => definition.description

const baseDirectory = await mkdtemp(join(tmpdir(), 'handoff-test-'))
const currentDirectory = join(baseDirectory, 'current')
const targetDirectory = join(baseDirectory, 'target', 'nested')

try {
  // 用例一：描述里必须列出当前工作区和当前模式，并且随工作区变化而更新。
  {
    const { ctx, record } = makeContext({
      workspaces: [{ id: 'ws-a', path: join(baseDirectory, 'alpha'), title: '甲项目' }],
    })
    apply(ctx)
    await settle()
    const first = readDescription(record.registered)
    assert.match(first, /甲项目/)
    assert.match(first, /standard/)
    assert.match(first, /planning/)
    assert.match(first, /轻量版标准模式/)
    // 没写说明的模式要如实指出，不能让模型以为它没有特性。
    assert.match(first, /bare：（该模式没有写说明）/)
    // 官方四个模式自己没写说明时，用插件内置的那份，装完即用。
    assert.match(first, /ptc：批量调用模式/)
    assert.match(first, /怎么选模式/)

    ctx.workspaceRegistry.list = () => [
      { id: 'ws-a', path: join(baseDirectory, 'alpha'), title: '甲项目' },
      { id: 'ws-b', path: join(baseDirectory, 'beta'), title: '乙项目' },
    ]
    const second = readDescription(record.registered)
    assert.match(second, /乙项目/)
  }

  // 用例一之二：工作区目录里的 AGENTS.md 开头会被摘成“这个工作区的身份”，显示在清单里。
  {
    const identityDirectory = join(baseDirectory, 'teacher')
    await mkdir(identityDirectory, { recursive: true })
    await writeFile(
      join(identityDirectory, 'AGENTS.md'),
      '# 中学数学老师\n\n我在这个目录里是中学数学老师，负责批改作业和备课，说话要耐心、写清每一步推导。\n',
      'utf8',
    )
    const { ctx, record } = makeContext({
      workspaces: [{ id: 'ws-t', path: identityDirectory, title: '老师的活' }],
    })
    apply(ctx)
    readDescription(record.registered) // 触发后台扫描
    await new Promise((done) => setTimeout(done, 60))
    const description = readDescription(record.registered)
    assert.match(description, /老师的活/)
    assert.match(description, /这个工作区的身份：中学数学老师/)
    assert.match(description, /批改作业和备课/)
  }

  // 用例一之三：说明文件顶部有元信息时，身份摘要取元信息里的 description，
  // 正文不参与——这正是技能文件“描述与内容分离”的做法，正文留给进去之后的会话读。
  {
    const layeredDirectory = join(baseDirectory, 'explorer')
    await mkdir(layeredDirectory, { recursive: true })
    await writeFile(
      join(layeredDirectory, 'AGENTS.md'),
      [
        '---',
        'description: 我在这个目录里是一个探索者：不断研究如何提升自己。',
        '---',
        '',
        '# 自我学习',
        '',
        '这一段是正文，不该出现在工具描述里。',
        '',
      ].join('\n'),
      'utf8',
    )
    const { ctx, record } = makeContext({
      workspaces: [{ id: 'ws-e', path: layeredDirectory, title: '探索区' }],
    })
    apply(ctx)
    readDescription(record.registered)
    await new Promise((done) => setTimeout(done, 60))
    const description = readDescription(record.registered)
    assert.match(description, /这个工作区的身份：我在这个目录里是一个探索者/)
    assert.equal(description.includes('这一段是正文'), false)
  }

  // 用例二：两个选填参数都不传 —— 落在当前会话目录，不带 agentPreset。
  {
    const { ctx, record } = makeContext()
    apply(ctx)
    const result = await record.registered.execute({ handoff: '  接着做后面的活  ' }, makeExec(currentDirectory))
    assert.deepEqual(record.created[0], { cwd: currentDirectory })
    // 交接内容不再作为“用户消息”投递：它由代码以“相邻会话转达”的身份写进新会话。
    assert.equal(record.prompted.length, 0)
    assert.equal(record.followed.length, 1)
    assert.equal(record.followed[0].sessionId, result.sessionId)
    const delivered = record.followed[0].message
    assert.equal(delivered.role, 'user')
    assert.deepEqual(delivered.source, {
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: 'session-parent',
    })
    // 第三版：正文里一个字的解释都没有，就是交接原文本身。
    // 新会话读到的第一段话不能是在讨论“这段文字”，否则它的注意力会被引到材料上。
    assert.equal(delivered.content.length, 1)
    assert.equal(delivered.content[0].text, '接着做后面的活')
    for (const banned of ['不是用户打的字', '记录', '交接班', '转达', '上一个会话', '换了个身份', '别把这份']) {
      assert.equal(delivered.content[0].text.includes(banned), false)
    }
    // 新会话要有名字，用户在列表里才认得出（交接内容不再冒充用户发言，标题不会被自动生成）。
    assert.deepEqual(record.renamed[0], { sessionId: result.sessionId, title: '接着做后面的活' })
    // 结果文本只陈述事实，不再要求模型在回复末尾提醒用户切过去。
    const rendered = record.registered.output.render({ handoff: '接着做后面的活' }, result)[0].text
    assert.match(rendered, /不是用户消息/)
    assert.equal(rendered.includes('在你回复用户的最后'), false)
    // 工具描述里也不再有“提醒用户切过去”这项义务；取而代之的是“欠的账要带走”。
    const description = readDescription(record.registered)
    assert.equal(description.includes('在你这一轮回复的末尾'), false)
    // 描述里要交代投递方式：接在这一轮的话后面、中间不插说明、要用第一人称续写。
    assert.match(description, /接在你这一轮对用户说的话后面/)
    assert.match(description, /中间不插任何“这是交接、这是别人转达”的说明/)
    assert.match(description, /用第一人称接着写/)
    assert.equal(description.includes('新会话会看到来源标注'), false)
    // 交接前把所有遗留都写进 handoff，交接后不许再留问题或待办。
    assert.match(description, /凡是还欠用户的/)
    assert.match(description, /不要再留任何问题或待办/)
    assert.match(description, /该由新会话说、新会话做/)
    // 调用即交接：交出去之后不许再回头读新会话的消息、日志或结果，也不许等它汇报。
    assert.match(description, /是交接班，不是派一个侦察兵/)
    assert.match(description, /不要回头去读它的消息/)
    assert.match(description, /写进 handoff 让它自己核对/)
    // 调用时机：这是当前对话里最后一步，像按下暂停键，按下后这边就停摆。
    assert.match(description, /像按下暂停键/)
    assert.match(description, /就此停摆/)
    assert.match(description, /像留遗嘱一样/)
    // 参数说明也要讲清：交接后这一轮再问也没人答。
    assert.match(record.registered.parameters.properties.handoff.description, /凡是还欠用户的东西都要写进来/)
    assert.match(record.registered.parameters.properties.handoff.description, /再问也没人答/)
    assert.match(record.registered.parameters.properties.handoff.description, /接在你这一轮对用户说的话后面/)
    assert.equal(result.directory, currentDirectory)
    assert.equal(result.preset, undefined)
    assert.equal(result.workspaceTitle, undefined)
  }

  // 用例二之一：会话里已有发言时，先接上最后一段有文字的助手发言，再接交接原文。
  {
    const { ctx, record } = makeContext()
    apply(ctx)
    const exec = makeExec(currentDirectory, [
      { role: 'user', content: [{ type: 'text', text: '开始吧' }] },
      // 只有工具调用、没有文字的那一步要跳过，不能把它当成“最后说的话”。
      { role: 'assistant', content: [{ type: 'tool-call', name: 'new_work' }] },
      { role: 'assistant', content: [{ type: 'text', text: '我先把进度记一下，交完这步就收手。' }] },
    ])
    await record.registered.execute({ handoff: '接着把插件改完' }, exec)
    const blocks = record.followed[0].message.content
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].text, '我先把进度记一下，交完这步就收手。')
    assert.equal(blocks[1].text, '接着把插件改完')
  }

  // 用例二之三：拿不到新会话的 agent 时退回会话控制器投递，正文里照样标明来源。
  {
    const { ctx, record } = makeContext()
    record.hideAgents = true
    apply(ctx)
    const result = await record.registered.execute({ handoff: '兜底也要讲清来源' }, makeExec(currentDirectory))
    assert.equal(record.followed.length, 0)
    assert.equal(record.prompted.length, 1)
    assert.equal(record.prompted[0].sessionId, result.sessionId)
    assert.match(record.prompted[0].content[0].text, /兜底也要讲清来源/)
    assert.equal(record.prompted[0].content[0].text.includes('不是用户打的字'), false)
    // 中止信号必须原样传给宿主：这是真实调用失败过一次（漏传）的地方。
    assert.equal(record.promptSignal instanceof AbortSignal, true)
  }

  // 用例二之二：不填 workspace，但当前目录本身就是一个已登记工作区 —— 只换状态，
  // 新会话仍挂在这个工作区下（传 workspaceId 而不是 cwd）。
  {
    const here = join(baseDirectory, 'here')
    await mkdir(here, { recursive: true })
    const { ctx, record } = makeContext({ workspaces: [{ id: 'ws-here', path: here, title: '当前这个' }] })
    apply(ctx)
    const result = await record.registered.execute(
      { handoff: '规划完了，开始写代码', preset: 'working' },
      makeExec(here),
    )
    assert.deepEqual(record.created[0], { workspaceId: 'ws-here', agentPreset: 'working' })
    assert.equal(result.workspaceTitle, '当前这个')
    assert.equal(result.preset, 'working')
    // 只换状态不开口说明：位置和模式由新会话的环境自己体现，正文里不写“你已经换到了某个状态”。
    assert.equal(record.followed[0].message.content.length, 1)
    assert.equal(record.followed[0].message.content[0].text, '规划完了，开始写代码')
  }

  // 用例三：给一个尚不存在的目录路径 —— 目录被创建出来，登记成工作区后用它建会话。
  {
    const { ctx, record } = makeContext()
    apply(ctx)
    const result = await record.registered.execute(
      { handoff: '到新目录继续', workspace: targetDirectory },
      makeExec(currentDirectory),
    )
    const info = await stat(targetDirectory)
    assert.equal(info.isDirectory(), true)
    assert.equal(record.created[0].workspaceId !== undefined, true)
    assert.equal(record.created[0].cwd, undefined)
    assert.equal(result.directory, targetDirectory)
  }

  // 用例四：按标题命中已有工作区 —— 传 workspaceId 而不是 cwd，并把模式传下去。
  {
    const existing = { id: 'ws-known', path: join(baseDirectory, 'known'), title: '我的项目' }
    const { ctx, record } = makeContext({ workspaces: [existing] })
    apply(ctx)
    const result = await record.registered.execute(
      { handoff: '回那个项目', workspace: '我的项目', preset: 'planning' },
      makeExec(currentDirectory),
    )
    assert.deepEqual(record.created[0], { workspaceId: 'ws-known', agentPreset: 'planning' })
    assert.equal(result.workspaceTitle, '我的项目')
    assert.equal(result.preset, 'planning')
    // 指定了工作区时，结果文本要写清落在哪个工作区、叫什么标题——用户才认得出。
    const rendered = record.registered.output.render({ handoff: '回那个项目继续' }, result)[0].text
    assert.match(rendered, /『我的项目』工作区/)
    assert.match(rendered, /标题是「回那个项目继续」/)
    // 换了工作区也不在正文里交代：新会话读到的只有交接原文，位置由环境自己体现。
    const relayText = record.followed[0].message.content[0].text
    assert.equal(relayText, '回那个项目')
    assert.equal(relayText.includes('子代理'), false)
  }

  // 用例五：空交接内容 —— 直接拒绝，不产生任何会话。
  {
    const { ctx, record } = makeContext()
    apply(ctx)
    await assert.rejects(
      () => record.registered.execute({ handoff: '   ' }, makeExec(currentDirectory)),
      /非空的交接内容/,
    )
    assert.equal(record.created.length, 0)
  }

  // 用例六：极简模式不带交接 —— 那个模式的会话创建时把 new_work 收窄掉；
  // 其他模式，以及没有模式标记的会话，保持原样。
  {
    const { ctx, record } = makeContext()
    apply(ctx)
    const listen = (agent) => {
      for (const listener of record.listeners['agent/created'] ?? []) listener({ agent })
    }
    const withPreset = (preset) => {
      const restrictions = []
      return {
        session: { header: { agentPreset: preset } },
        ctx: { tools: { restrict: (filter) => { restrictions.push(filter) } } },
        restrictions,
      }
    }
    const minimal = withPreset('minimal')
    const standard = withPreset('standard')
    const unlabeled = withPreset(undefined)
    listen(minimal)
    listen(standard)
    listen(unlabeled)
    assert.deepEqual(minimal.restrictions, [{ deny: ['new_work'] }])
    assert.deepEqual(standard.restrictions, [])
    assert.deepEqual(unlabeled.restrictions, [])
  }

  console.log('全部用例通过')
} finally {
  await rm(baseDirectory, { recursive: true, force: true })
}
