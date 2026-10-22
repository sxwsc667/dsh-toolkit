/**
 * dsh-tool-compact 的冒烟测试：不启动宿主，用一个假上下文验证三件事。
 *
 * 1. 工具被调用时只登记任务，绝不立刻压缩（压缩服务不能被调用）；
 * 2. 会话没进入空闲就不执行，进入空闲才执行，且只执行一次；
 * 3. 压缩抛错时最多重试到上限，然后放弃。
 *
 * 跑法：node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { apply } from '../index.js'

/**
 * 造一个够用的假宿主上下文，并记录插件对它的每一次调用。
 *
 * @param {object} options
 * @param {'ok' | 'null' | 'throw'} options.compactOutcome 压缩服务的行为。
 * @returns {{ ctx: object, tool: object, emitStatus: Function, compactCalls: object[] }} 假宿主与观测点。
 */
function createFakeHost({ compactOutcome = 'ok' } = {}) {
  const registeredTools = []
  const statusListeners = []
  const compactCalls = []
  const logs = []

  const ctx = {
    tools: {
      register(definition) {
        registeredTools.push(definition)
        return () => {}
      },
    },
    compaction: {
      async compactNow(agent, signal) {
        compactCalls.push({ agent, signal })
        if (compactOutcome === 'throw') throw new Error('busy：another maintenance task owns the agent')
        if (compactOutcome === 'null') return null
        return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1200 }
      },
    },
    on(event, listener) {
      if (event === 'agent/status') statusListeners.push(listener)
      return () => {}
    },
    logger: {
      info: (...args) => logs.push({ level: 'info', args }),
      warn: (...args) => logs.push({ level: 'warn', args }),
    },
  }

  return {
    ctx,
    tool: registeredTools,
    compactCalls,
    logs,
    /** 触发一次状态变化，同步驱动插件的监听器。 */
    emitStatus(status, agent) {
      for (const listener of statusListeners) listener({ status, agent })
    },
    getRegisteredTool() {
      return registeredTools[0]
    },
  }
}

/**
 * 造一个最小的 agent 载荷，插件只从中读编号。
 *
 * @param {string} id agent 编号。
 * @returns {{ id: string, session: { id: string } }} 假 agent。
 */
function createFakeAgent(id) {
  return { id, session: { id } }
}

/** 让出一轮事件循环，等异步的压缩尝试跑完。 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// 用例一：调用工具只登记，不动压缩服务。
{
  const host = createFakeHost()
  apply(host.ctx)
  const tool = host.getRegisteredTool()
  assert.ok(tool !== undefined, '插件应当登记一个工具')
  assert.equal(tool.name, 'compact')

  const result = await tool.execute({}, { agent: createFakeAgent('session-a') })
  assert.deepEqual(result, { accepted: true })
  assert.equal(host.compactCalls.length, 0, '调用工具时不得立刻压缩')
  console.log('用例一通过：调用只登记，不立刻压缩')
}

// 用例二：running 状态不触发，idle 才触发，且只触发一次。
{
  const host = createFakeHost()
  apply(host.ctx)
  const agent = createFakeAgent('session-b')
  await host.getRegisteredTool().execute({}, { agent })

  host.emitStatus('running', agent)
  await settle()
  assert.equal(host.compactCalls.length, 0, '会话还在跑时不得压缩')

  host.emitStatus('idle', agent)
  await settle()
  assert.equal(host.compactCalls.length, 1, '会话空闲后应当压缩一次')

  host.emitStatus('idle', agent)
  await settle()
  assert.equal(host.compactCalls.length, 1, '任务已完成后不得重复压缩')
  console.log('用例二通过：只在空闲时执行，且不重复')
}

// 用例三：没登记过的会话空闲时什么都不做。
{
  const host = createFakeHost()
  apply(host.ctx)
  host.emitStatus('idle', createFakeAgent('session-c'))
  await settle()
  assert.equal(host.compactCalls.length, 0, '没登记任务的会话不该被压缩')
  console.log('用例三通过：未登记的会话不受影响')
}

// 用例四：没有可压缩历史时安静结束，不重试。
{
  const host = createFakeHost({ compactOutcome: 'null' })
  apply(host.ctx)
  const agent = createFakeAgent('session-d')
  await host.getRegisteredTool().execute({}, { agent })
  host.emitStatus('idle', agent)
  await settle()
  assert.equal(host.compactCalls.length, 1, '没有可压缩历史时只尝试一次')
  host.emitStatus('idle', agent)
  await settle()
  assert.equal(host.compactCalls.length, 1, '没有可压缩历史时不得重试')
  console.log('用例四通过：无历史可压时只尝试一次')
}

// 用例五：压缩失败时重试到上限 3 次，之后放弃。
{
  const host = createFakeHost({ compactOutcome: 'throw' })
  apply(host.ctx)
  const agent = createFakeAgent('session-e')
  await host.getRegisteredTool().execute({}, { agent })

  for (let round = 0; round < 5; round += 1) {
    host.emitStatus('idle', agent)
    await settle()
  }
  assert.equal(host.compactCalls.length, 3, '失败最多尝试 3 次')
  assert.ok(
    host.logs.some((entry) => entry.level === 'warn'),
    '放弃时应当留下警告日志',
  )
  console.log('用例五通过：失败重试有上限，超限放弃')
}

console.log('全部用例通过')
