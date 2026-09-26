// Local functional check: socket.io (engine.io -> ws) still works end to
// end after the ws resolutions bump. Not a substitute for a real socket.io
// route (DmService/websocket.ts) test — just confirms the transport itself.
import { Server } from 'socket.io'
import { io as ioClient } from 'socket.io-client'
import { createServer } from 'node:http'

const httpServer = createServer()
const ioServer = new Server(httpServer)

await new Promise((resolve) => httpServer.listen(0, resolve))
const port = httpServer.address().port

ioServer.on('connection', (socket) => {
  socket.on('ping', () => socket.emit('pong'))
})

const client = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'] })

await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('timed out waiting for connect')), 5000)
  client.on('connect', () => { clearTimeout(timeout); resolve() })
  client.on('connect_error', reject)
})
console.log('connected over websocket transport')

const pong = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('timed out waiting for pong')), 5000)
  client.on('pong', () => { clearTimeout(timeout); resolve(true) })
  client.emit('ping')
})
console.log(`round-trip message ok: ${pong}`)

client.close()
await ioServer.close()
console.log('ALL CHECKS PASSED')
process.exit(0)
