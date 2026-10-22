// 一次性脚本：把工具描述与开场白的实际文本打印出来给人看。
// 不写入插件、不参与自测，看完即删。
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const base = await mkdtemp(join(tmpdir(), 'handoff-preview-'))
const here = join(base, 'current')
const there = join(base, 'explorer')
await mkdir(here, { recursive: true })
await mkdir(there, { recursive: true })
await writeFile(
  join(there, 'AGENTS.md'),
  '---\ndescription: 我在这个目录里是一个探索者：不断研究如何提升自己。\n---\n\n# 自我学习\n\n正文。\n',
  'utf8',
)

const record = { registered: undefined, followed: [], agents: new Map() }
const ctx = {
  tools: { register: (definition) => { record.registered = definition } },
  // 预览不验证事件行为，监听器直接丢弃。
  on: () => () => {},
  inject: (_deps, callback) => { callback(ctx) },
  get: (name) => ctx[name],
  agents: { get: (id) => record.agents.get(id) },
  workspaceRegistry: {
    list: () => [{ id: 'ws-e', path: there, title: '探索区' }],
    resolveByPath: async () => undefined,
    create: async (path) => ({ id: 'ws-new', path, title: path }),
  },
  sessionController: {
    create: async () => {
      const sessionId = 'session-preview'
      record.agents.set(sessionId, { id: sessionId, followup: (m) => record.followed.push(m) })
      return { sessionId }
    },
    prompt: async () => ({}),
    rename: async () => ({}),
  },
  agentPresets: {
    defaultId: 'standard',
    list: async () => [
      { id: 'standard', name: '标准模式', description: '完整工具集。' },
      { id: 'planning', name: '协作模式', description: '轻量版标准模式。' },
    ],
  },
}

apply(ctx)
// 身份摘要是首轮渲染时异步发起的，且节流 30 秒；所以先触发一次渲染、等扫描落地，再取最终文本。
record.registered.description
await new Promise((done) => setTimeout(done, 200))
const description = record.registered.description

console.log('===== 工具描述：身份/状态两段实际文本 =====')
const lines = description.split('\n')
const start = lines.findIndex((line) => line.includes('先把两个词说清楚'))
const end = lines.findIndex((line, index) => index > start && line.includes('什么时候用'))
console.log(lines.slice(start, end).join('\n'))

console.log('\n===== 工具描述：清单标题 =====')
for (const line of lines) {
  if (/工作区|可选状态|可选模式/.test(line) && line.length < 120) console.log(line)
}

/** 造一个带会话历史的执行上下文；lastReply 模拟本轮调用工具前已落盘的发言。 */
function makeExec(messages) {
  return {
    agent: {
      id: 'session-parent',
      session: { header: { cwd: here }, deriveMessages: () => messages },
    },
    signal: new AbortController().signal,
  }
}

const history = [
  { role: 'user', content: [{ type: 'text', text: '把插件改一下' }] },
  { role: 'assistant', content: [{ type: 'text', text: '改完了，自测也通过了。我把进度记下来，这步做完就停在这边。' }] },
  { role: 'assistant', content: [{ type: 'tool-call', name: 'new_work' }] },
]

console.log('\n===== 投递内容：换工作区 + 换模式（前面接上最后一句发言）=====')
await record.registered.execute(
  { handoff: '（这里是一段交接正文）', workspace: '探索区', preset: 'standard' },
  makeExec(history),
)
for (const [index, block] of record.followed.at(-1).content.entries()) {
  console.log(`--- 第 ${index + 1} 块 ---`)
  console.log(block.text)
}

console.log('\n===== 投递内容：只换状态、且会话里还没有发言 =====')
record.followed.length = 0
await record.registered.execute(
  { handoff: '（这里是一段交接正文）', preset: 'planning' },
  makeExec([]),
)
for (const [index, block] of record.followed.at(-1).content.entries()) {
  console.log(`--- 第 ${index + 1} 块 ---`)
  console.log(block.text)
}

await rm(base, { recursive: true, force: true })
