// 用真实的 cordis 上下文加载插件，验证 apply 在三种时序下都不抛错：
//   1. 模式注册表根本不存在（精简部署）；
//   2. 模式注册表已就绪；
//   3. 模式注册表已声明但尚未就绪（宿主里的真实时序，最容易让插件加载失败的那种）。
// 这是本地复现宿主加载行为的最小手段：不启动 DSH，但用的是同一套插件容器。
//
// 宿主的安装位置各机器不同，不能写死在脚本里：设环境变量 DSH_CORDIS_PATH
// 指向宿主里那份 cordis 的入口文件即可；没设且解析不到就跳过这项测试——跳过不算失败。
import { pathToFileURL } from 'node:url'
import * as plugin from '../index.js'

/**
 * 找到宿主里那份 cordis 的入口文件地址。
 * 先读环境变量 DSH_CORDIS_PATH（用户显式指定）；没有就退回普通模块解析。
 * @returns {Promise<string | null>} 可直接 import 的地址；找不到时返回 null。
 */
async function findCordisEntry() {
  const explicitPath = process.env.DSH_CORDIS_PATH
  if (explicitPath) return pathToFileURL(explicitPath).href
  try {
    return import.meta.resolve('@deepseek-ai/cordis')
  } catch {
    return null
  }
}

const cordisEntry = await findCordisEntry()
if (!cordisEntry) {
  console.log('未找到宿主安装位置，跳过加载测试（可设环境变量 DSH_CORDIS_PATH 指向 cordis 入口文件）')
  process.exit(0)
}
const { Context } = await import(cordisEntry)

/** 一个可用的假模式注册表。 */
const fakePresets = {
  defaultId: 'standard',
  list: async () => [{ id: 'standard', name: '标准模式', description: '默认。' }],
}

/**
 * 搭一个带假服务的根上下文。
 * @param {'absent' | 'ready' | 'pending'} scenario 模式注册表的就绪状态。
 */
function makeContext(scenario) {
  const ctx = new Context()
  const registered = []
  ctx.provide('tools', { register: (definition) => { registered.push(definition); return () => {} } })
  ctx.provide('sessionController', { create: async () => ({ sessionId: 's' }), prompt: async () => ({}) })
  ctx.provide('workspaceRegistry', { list: () => [], resolveByPath: async () => undefined, create: async (p) => ({ id: 'w', path: p, title: p }) })
  if (scenario === 'ready') {
    ctx.provide('agentPresets', fakePresets)
  }
  if (scenario === 'pending') {
    // 只声明、不给值：模拟宿主里“服务还没初始化完”的那一刻。
    ctx.provide('agentPresets')
  }
  return { ctx, registered }
}

const labels = { absent: '模式服务不存在', ready: '模式服务已就绪', pending: '模式服务已声明未就绪' }

for (const scenario of ['absent', 'ready', 'pending']) {
  const { ctx, registered } = makeContext(scenario)
  try {
    ctx.plugin(plugin)
    await new Promise((done) => setTimeout(done, 30))
    if (registered.length !== 1) throw new Error(`工具没有登记成功（登记了 ${registered.length} 个）`)
    const description = registered[0].description
    if (typeof description !== 'string' || description.length === 0) throw new Error('工具描述为空')

    // 未就绪的那种：补上服务值，确认下一轮渲染能读到它（读取本身是异步的）。
    if (scenario === 'pending') {
      ctx.set('agentPresets', fakePresets)
      registered[0].description // 触发一次读取
      await new Promise((done) => setTimeout(done, 30))
      if (!registered[0].description.includes('标准模式')) throw new Error('服务就绪后描述里仍未出现模式清单')
    }
    console.log(`${labels[scenario]}：加载正常`)
  } catch (error) {
    console.log(`${labels[scenario]}：加载失败 —— ${error?.stack ?? error}`)
    process.exitCode = 1
  }
}
