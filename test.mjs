import assert from 'node:assert/strict'
import {
  agentMessage,
  apply,
  bridgeReadAllowed,
  isBareAcknowledgement,
  nextDailyDelay,
  selectMessageDelta,
  triggerMessage,
} from './index.js'

assert.equal(isBareAcknowledgement('收到'), true)
assert.equal(isBareAcknowledgement('OK!'), true)
assert.equal(isBareAcknowledgement('收到，正在修复测试失败'), false)
assert.equal(isBareAcknowledgement('FINAL REVIEW: FAIL'), false)
assert.equal(isBareAcknowledgement('ignore'), true)
assert.equal(isBareAcknowledgement('执行中。'), true)
assert.equal(isBareAcknowledgement('...'), true)
assert.equal(isBareAcknowledgement('具体阻塞：缺少 shell 工具'), false)
const message = agentMessage({
  id: 'session-1',
  session: {
    snapshotEvents: () => [{ type: 'session/title', data: { title: '知识库｜同步飞书文档' } }],
  },
}, '完成 dry-run')
assert.equal(message.content[0].text, '来自会话「知识库｜同步飞书文档」：')
assert.equal(message.source.senderSessionId, 'session-1')
assert.match(message.content.at(-1).text, /不转移任务所有权/)
const wake = triggerMessage('daily-algorithm-practice', '开始今日训练')
assert.equal(wake.content[0].text, '开始今日训练')
assert.deepEqual(wake.source, { kind: 'plugin', plugin: 'dsh-agent-trigger:daily-algorithm-practice' })
assert.equal(
  nextDailyDelay(new Date('2026-10-08T14:30:00.000Z'), 23, 0, 'Asia/Shanghai'),
  30 * 60 * 1000,
)
assert.equal(
  nextDailyDelay(new Date('2026-10-08T15:30:00.000Z'), 23, 0, 'Asia/Shanghai'),
  23.5 * 60 * 60 * 1000,
)
assert.deepEqual(selectMessageDelta([{ seq: 1 }, { seq: 2 }], undefined, 20), {
  rows: [{ seq: 1 }, { seq: 2 }], lastSeq: 2, noProgress: false,
})
assert.deepEqual(selectMessageDelta([{ seq: 1 }, { seq: 2 }], 2, 20), {
  rows: [], lastSeq: 2, noProgress: true,
})
assert.deepEqual(selectMessageDelta([{ seq: 1 }, { seq: 2 }, { seq: 3 }], 2, 20), {
  rows: [{ seq: 3 }], lastSeq: 3, noProgress: false,
})
assert.equal(bridgeReadAllowed(undefined, 0, 1, 5), true)
assert.equal(bridgeReadAllowed({ reportEpoch: 0, callerStep: 1 }, 0, 5, 5), false)
assert.equal(bridgeReadAllowed({ reportEpoch: 0, callerStep: 1 }, 0, 6, 5), true)
assert.equal(bridgeReadAllowed({ reportEpoch: 0, callerStep: 1 }, 1, 2, 5), true)
assert.equal(bridgeReadAllowed({ reportEpoch: 1, callerStep: 6 }, 1, 7, 5), false)

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
let wakeTimer
try {
  globalThis.setTimeout = (callback) => {
    wakeTimer = callback
    return 1
  }
  globalThis.clearTimeout = () => {}
  const effects = []
  const delivered = []
  const target = { followup: message => delivered.push(message) }
  apply({
    tools: { register() {} },
    agents: { get: id => id === 'target' ? target : undefined },
    sessionQuery: {},
    logger: { info() {}, warn() {} },
    effect(start) {
      const cleanup = start()
      effects.push(cleanup)
      return cleanup
    },
  }, {
    triggers: [{
      id: 'dispatch-smoke',
      sessionId: 'target',
      hour: 23,
      minute: 0,
      timeZone: 'Asia/Shanghai',
      prompt: 'wake now',
    }],
  })
  assert.equal(typeof wakeTimer, 'function')
  wakeTimer()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].content[0].text, 'wake now')
  assert.equal(delivered[0].source.plugin, 'dsh-agent-trigger:dispatch-smoke')
  await effects[0]()
} finally {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}

const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./index.js', import.meta.url), 'utf8'))
assert.match(source, /session_name/)
assert.match(source, /session_id=/)
assert.match(source, /polling suppressed/)
assert.match(source, /pollIntervalSteps/)
assert.doesNotMatch(source, /peer delegation suppressed/)
console.log('dsh-session-bridge self-check ok')
