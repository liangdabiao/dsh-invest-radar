// 开发预览：把投资雷达面板跑在独立 http 服务上（复用 lib/api.js 路由 + 真实数据）。
//   DSH_HOME=<数据目录> node scripts/devserver.mjs [port]   默认 5175
import { createServer } from 'node:http'
import { registerApi } from '../lib/api.js'

const port = Number(process.argv[2]) || 5175
const routes = {}
const fakeCtx = { get: () => undefined, webServer: { register: (r) => { routes[r.path] = r.handler } } }
registerApi(fakeCtx)

createServer(async (req, res) => {
  try {
    await routes['/invest-radar'](req, res)
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: e.message }))
  }
}).listen(port, () => console.log(`[dev] http://127.0.0.1:${port}/invest-radar/  (DSH_HOME=${process.env.DSH_HOME || '~/.dsh'})`))
