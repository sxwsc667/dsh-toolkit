/**
 * 本插件的稳定标识，也是 cordis.patch.yml 里插入那一行的对照物。
 */
export const name = 'tool-compact'

/**
 * 本插件依赖的宿主服务：
 * - tools（工具登记表）：用来登记对模型可见的工具。
 * - compaction（压缩服务）：插件不自己实现压缩，登记好后交给它执行。
 *
 * 压缩执行时间的判断依赖宿主事件 `agent/status`，不属于注入项。
 */
export const inject = ['tools', 'compaction']

/**
 * 对模型可见的工具名。
 */
const TOOL_NAME = 'compact'

/**
 * 一个任务的执行次数上限。
 *
 * 压缩只在会话真空闲时才能启动，撞上别的维护任务会抛 busy；
 * 这类失败大多是瞬时的，所以保留任务等下一次空闲重试，但不无限重试——
 * 一直失败就丢掉，免得每次空闲都白跑一次摘要请求。
 */
const MAX_ATTEMPTS = 3

/**
 * 工具描述：模型每次读工具清单时看到的那段话。
 *
 * 光有一个压缩工具，模型基本不会主动用（Deep Agents 的实测是一次都没触发），
 * 所以这里把「值得压的时机」直接写进描述——描述本身就是模型可见的提示词，
 * 不必再改系统提示。
 */
const TOOL_DESCRIPTION =
  '提交一次上下文压缩：把本次会话较早的历史合成一条摘要，腾出上下文空间。' +
  '原始内容不会被删除，仍留在会话记录里。\n' +
  '\n' +
  '这个工具不压缩、不等待、不返回摘要。它只登记一个任务，等你这一轮说完话、' +
  '会话空下来之后才真正执行。所以调用它之后不要停下来等结果，接着说你要说的话。\n' +
  '\n' +
  '值得提交的时机（由你自己判断，不要求达到任何长度上限）：\n' +
  '- 一段任务已经收尾干净，结论已经定下来，后面的推导过程用不到了；\n' +
  '- 刚把大量材料读完并提炼出结论（长文件、长日志、多条搜索结果）；\n' +
  '- 接下来要吞进大量新内容（读大文件、长网页、跑长命令），先把旧的压掉；\n' +
  '- 即将进入一条很长的流程（连续多次改代码、多轮排查）；\n' +
  '- 原先的结论被推翻，留着旧上下文只会误导后面的判断。\n' +
  '\n' +
  '不该提交的时机：\n' +
  '- 还在一个连续任务中间，前因后果马上要用；\n' +
  '- 还需要引用早期原文（具体代码、报错、用户原话），但还没摘出来——先摘出来再提交；\n' +
  '- 本轮马上结束、且没有需要留存的结论：不提交也行，不必为了压缩而压缩。'

/**
 * 取一个会话或 agent 的稳定编号，作为待压缩任务的登记键。
 *
 * 插件只在进程内记任务，不写会话记录：压缩本身已经由压缩服务写进日志，
 * 这里多写一份反而会让回放多出一种状态。编号优先用 agent 自己的 id。
 *
 * @param agentOrSession 宿主交给插件的事件载荷，可能是 agent 也可能是会话。
 * @returns {string | undefined} 登记键；取不到时为 undefined。
 */
function registryKeyOf(agentOrSession) {
  const agentId = agentOrSession?.id
  if (typeof agentId === 'string' && agentId.length > 0) return agentId
  const sessionId = agentOrSession?.session?.id ?? agentOrSession?.sessionId
  if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId
  return undefined
}

/**
 * 在会话空闲时执行一次已登记的压缩。
 *
 * 压缩服务自己负责选保留范围、调摘要模型、写会话记录，插件这里只负责
 * 「挑对时机」和「失败怎么办」。因为成功与否都发生在这一轮对话之后，
 * 结果无法再告诉模型，只能进日志。
 *
 * @param ctx 宿主上下文，携带 compaction（压缩服务）与日志器。
 * @param agent 要压缩的会话所属 agent。
 * @param key 该 agent 的登记键。
 * @param bookkeeping 待办表：key → { attempts, running }，由插件实例共享。
 * @returns {Promise<void>} 压缩尝试结束后兑现；从不抛出。
 */
async function runPendingCompaction(ctx, agent, key, bookkeeping) {
  const task = bookkeeping.get(key)
  if (task === undefined || task.running) return
  task.running = true
  try {
    // 取消信号由压缩服务自己按需触发；这里给一个干净的信号，
    // 让宿主在会话被取消时能顺着它中止正在跑的摘要请求。
    const controller = new AbortController()
    const result = await ctx.compaction.compactNow(agent, controller.signal)
    bookkeeping.delete(key)
    if (result === null) {
      ctx.logger?.info?.('tool-compact：%s 没有可压缩的历史，任务结束', key)
      return
    }
    ctx.logger?.info?.(
      'tool-compact：%s 压缩完成，遮蔽 %d 个节点，约释放 %d token',
      key,
      result.shadowedSeqs.length,
      result.shadowedTokenCount,
    )
  } catch (error) {
    task.attempts -= 1
    const detail = String(error?.message ?? error)
    if (task.attempts > 0) {
      ctx.logger?.warn?.('tool-compact：%s 压缩失败，等下次空闲重试：%s', key, detail)
      return
    }
    bookkeeping.delete(key)
    ctx.logger?.warn?.('tool-compact：%s 压缩失败，已放弃：%s', key, detail)
  } finally {
    // 删除过的条目不能再改它的属性：对象已经不在表里了，这里只负责解除占用标记。
    if (bookkeeping.has(key)) task.running = false
  }
}

/**
 * 登记 compact（提交一次上下文压缩，会话空闲后执行）。
 *
 * @param ctx 宿主上下文，携带 tools（工具登记表）与 compaction（压缩服务）两个服务。
 * @returns {void} 无返回值；副作用是登记一个工具并挂一个空闲事件监听，插件卸载时由宿主自动撤销。
 */
export function apply(ctx) {
  /** 待压缩任务表：登记键 → { attempts: 剩余执行次数, running: 是否正在执行 }。 */
  const bookkeeping = new Map()

  ctx.tools.register({
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['accepted'],
        properties: {
          accepted: { type: 'boolean' },
        },
      },
      render: () => [
        {
          type: 'text',
          text:
            '已提交。压缩会在这一轮结束后、会话空下来时自动执行，你不用等，也不用再确认。' +
            '接着说你要说的话就行；下一轮你看到的历史里，较早的部分会变成一条摘要。',
        },
      ],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('compact 必须由某个会话发起')
      const key = registryKeyOf(agent)
      if (key === undefined) throw new Error('compact 找不到当前会话的编号')

      bookkeeping.set(key, { attempts: MAX_ATTEMPTS, running: false })
      return { accepted: true }
    },
    presentCall: () => ({
      card: 'generic',
      title: '提交压缩',
      kind: 'other',
      rawInput: '本轮结束后压缩较早的历史',
    }),
  })

  // 压缩必须等这一轮真正结束后再做：工具是在回合中间执行的，
  // 那时会话还占着，压缩服务会拒绝启动。`idle` 表示没有驱动在跑也没有排队，
  // 正是「当前会话已经结束」的那一刻。
  ctx.on('agent/status', (payload) => {
    if (payload?.status !== 'idle') return
    const agent = payload.agent
    const key = registryKeyOf(agent)
    if (key === undefined || !bookkeeping.has(key)) return
    void runPendingCompaction(ctx, agent, key, bookkeeping)
  })
}
