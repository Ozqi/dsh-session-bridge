export const name = 'dsh-session-bridge'
export const inject = ['tools', 'agents', 'sessionQuery']

function textOf(content = []) {
  return content.flatMap((block) => {
    if (block?.type === 'text') return [block.text]
    if (block?.type === 'image') return ['[image]']
    if (block?.type === 'file') return [`[file:${block.attachment?.name ?? ''}]`]
    if (block?.type === 'tool-call') return [`[tool-call:${block.name ?? ''}]`]
    if (block?.type === 'tool-result') return ['[tool-result]']
    return []
  }).join('\n')
}

function titleFrom(events, fallback = 'untitled') {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type === 'session/title' && event.data?.title) return event.data.title
  }
  return fallback
}

function makeId() {
  return `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function userMessage(content, source) {
  return { id: makeId(), role: 'user', content, source }
}

export function isBareAcknowledgement(text) {
  const value = String(text).trim()
  return /^(收到|好的?|明白|了解|ok|okay|ack|got it|已收到)[！!。.\s]*$/iu.test(value)
    || /^(执行中|正在执行|开始|继续|静默|勿回|无需回应|不要回复|不需反馈|请忽略|ignore|do not respond|最终结果稍后回传|后续仅最终)[！!。.\s…]*$/iu.test(value)
    || /^[！!。.\s…]+$/u.test(value)
}

export function agentMessage(sender, text) {
  const events = typeof sender.session?.snapshotEvents === 'function'
    ? sender.session.snapshotEvents()
    : []
  const title = titleFrom(events, String(sender.id))
  return userMessage([
    { type: 'text', text: `来自会话「${title}」：` },
    { type: 'text', text },
    {
      type: 'text',
      text: `\n\n[Bridge 协议：不要回复“收到/OK”等纯确认。只在有实质进展、阻塞或最终结果时，主动用 session_bridge_send 回传给 session_id=${sender.id}、session_name=${title}；这可提前解锁发送方的下一次检查。Bridge 不转移任务所有权，除非本消息明确分配了一个有边界的独立子任务。]`,
    },
  ], { kind: 'agent-message', form: 'relay', senderSessionId: sender.id })
}

export function triggerMessage(triggerId, prompt) {
  return userMessage([
    { type: 'text', text: prompt },
  ], { kind: 'plugin', plugin: `dsh-agent-trigger:${triggerId}` })
}

export function selectMessageDelta(rows, previousSeq, limit) {
  const selected = previousSeq === undefined
    ? rows.slice(-limit)
    : rows.filter(row => row.seq > previousSeq).slice(-limit)
  return {
    rows: selected,
    lastSeq: rows.at(-1)?.seq ?? previousSeq,
    noProgress: selected.length === 0,
  }
}

export function bridgeReadAllowed(previous, reportEpoch, callerStep, intervalSteps) {
  return previous === undefined
    || previous.reportEpoch !== reportEpoch
    || callerStep - previous.callerStep >= intervalSteps
}

function currentStep(events) {
  return events.reduce((count, event) => count + (event?.type === 'step/start' ? 1 : 0), 0)
}

export function nextDailyDelay(now, hour, minute, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]))
  const elapsed = ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000 + now.getMilliseconds()
  let delay = ((hour * 60 + minute) * 60 * 1000) - elapsed
  if (delay <= 0) delay += 24 * 60 * 60 * 1000
  return delay
}

function validateTrigger(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('trigger must be an object')
  const id = String(raw.id ?? '').trim()
  const sessionId = String(raw.sessionId ?? '').trim()
  const prompt = String(raw.prompt ?? '').trim()
  const timeZone = String(raw.timeZone ?? '').trim()
  const hour = raw.hour
  const minute = raw.minute
  if (!id) throw new Error('trigger id must be non-empty')
  if (!sessionId) throw new Error(`trigger "${id}" sessionId must be non-empty`)
  if (!prompt) throw new Error(`trigger "${id}" prompt must be non-empty`)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`trigger "${id}" hour must be 0..23`)
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error(`trigger "${id}" minute must be 0..59`)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format()
  } catch {
    throw new Error(`trigger "${id}" timeZone must be an IANA time zone`)
  }
  return Object.freeze({ id, sessionId, prompt, timeZone, hour, minute })
}

function installDailyTrigger(ctx, raw) {
  const trigger = validateTrigger(raw)
  let timer
  let stopped = false
  let active

  const arm = () => {
    if (stopped) return
    const delay = nextDailyDelay(new Date(), trigger.hour, trigger.minute, trigger.timeZone)
    timer = setTimeout(() => {
      timer = undefined
      active = dispatch().finally(() => {
        active = undefined
        arm()
      })
    }, delay)
  }

  const dispatch = async () => {
    try {
      let target = ctx.agents.get(trigger.sessionId)
      if (!target) target = (await ctx.agents.resume({ resumeSessionId: trigger.sessionId })).agent
      if (stopped) return
      target.followup(triggerMessage(trigger.id, trigger.prompt))
      ctx.logger.info(`agent trigger "${trigger.id}" delivered to Session "${trigger.sessionId}"`)
    } catch (error) {
      ctx.logger.warn(`agent trigger "${trigger.id}" failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  arm()
  return async () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    await active
  }
}

function tool(def) {
  return {
    ...def,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
  }
}

export function apply(ctx, config = {}) {
  const readCursors = new Map()
  const readStates = new Map()
  const reportEpochs = new Map()
  const pollIntervalSteps = Number.isSafeInteger(config.pollIntervalSteps) && config.pollIntervalSteps > 0
    ? config.pollIntervalSteps
    : 5
  for (const trigger of config.triggers ?? []) ctx.effect(() => installDailyTrigger(ctx, trigger))

  ctx.tools.register(tool({
    name: 'session_bridge_list',
    description: 'List all visible DSH sessions across workspaces, with session id, session name, cwd, and availability. When calling the other bridge tools, copy both session_id and session_name for readable tool history.',
    parameters: { type: 'object', properties: {} },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('session_bridge_list requires a calling agent')
      const records = await ctx.sessionQuery.listSessions(exec.signal)
      const rows = []
      for (const record of records) {
        if (record.header.id === caller.id) continue
        let title = 'untitled'
        try {
          using observation = await ctx.sessionQuery.observeSession(record.header.id, { signal: exec.signal, projectionMode: 'none' })
          title = titleFrom(observation.events)
        } catch {}
        const availability = [record.live ? 'live' : undefined, record.persisted ? 'persisted' : undefined].filter(Boolean).join(', ') || 'unavailable'
        rows.push(`session_id=${record.header.id} | session_name=${title} | cwd=${record.header.cwd ?? '(no cwd)'} | ${availability}`)
      }
      return rows.length === 0 ? '(no other sessions)' : rows.join('\n')
    },
  }))

  ctx.tools.register(tool({
    name: 'session_bridge_messages',
    description: 'Read new user and assistant messages from another DSH session. Do not busy-poll: the same caller may check one target only once per configured caller-step interval (default 5 steps). A proactive session_bridge_send from the target unlocks an earlier check. This is not a synchronous job-wait tool.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target session id used for routing.' },
        session_name: { type: 'string', description: 'Target session name copied from session_bridge_list for readable tool history; display only.' },
        limit: { type: 'integer', description: 'Maximum messages to show; default 20, max 100.' },
      },
      required: ['session_id'],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('session_bridge_messages requires a calling agent')
      if (args.session_id === caller.id) throw new Error('target must be another session')
      const limit = Math.min(Math.max(Number.isSafeInteger(args.limit) ? args.limit : 20, 1), 100)
      using observation = await ctx.sessionQuery.observeSession(args.session_id, { signal: exec.signal, projectionMode: 'none' })
      const rows = []
      for (const event of observation.events) {
        if (event.type === 'user/message') rows.push({ seq: event.seq, role: 'user', source: event.data.source?.kind ?? 'unknown', text: textOf(event.data.content) })
        else if (event.type === 'assistant/message') rows.push({ seq: event.seq, role: 'assistant', source: event.data.message?.source?.kind ?? 'unknown', text: textOf(event.data.message?.content) })
      }
      const cursorKey = `${caller.id}\u0000${args.session_id}`
      const reportKey = `${args.session_id}\u0000${caller.id}`
      const reportEpoch = reportEpochs.get(reportKey) ?? 0
      const readState = readStates.get(cursorKey)
      const callerEvents = typeof caller.session?.snapshotEvents === 'function'
        ? caller.session.snapshotEvents()
        : []
      const callerStep = currentStep(callerEvents)
      if (!bridgeReadAllowed(readState, reportEpoch, callerStep, pollIntervalSteps)) {
        const remaining = pollIntervalSteps - (callerStep - readState.callerStep)
        throw new Error(`polling suppressed: wait ${remaining} more caller step(s), or wait for the target to proactively use session_bridge_send`)
      }
      const previousSeq = readCursors.get(cursorKey)
      const delta = selectMessageDelta(rows, previousSeq, limit)
      readCursors.set(cursorKey, delta.lastSeq)
      readStates.set(cursorKey, { reportEpoch, callerStep })
      const sessionName = String(args.session_name ?? '').trim() || titleFrom(observation.events)
      if (delta.noProgress) {
        return `NO_NEW_MESSAGES from ${sessionName} (${args.session_id}). Wait at least ${pollIntervalSteps} caller steps before checking again, unless the target proactively reports first.`
      }
      return [
        `Session ${sessionName} (${args.session_id}) — ${delta.rows.length} new message(s) through seq ${delta.lastSeq}.`,
        ...delta.rows.map(row => `- ${row.seq} ${row.role}/${row.source}: ${row.text || '(no text)'}`),
        `Do not busy-poll. Check again only after ${pollIntervalSteps} more caller steps, or sooner after a proactive target report.`,
      ].join('\n')
    },
  }))

  ctx.tools.register(tool({
    name: 'session_bridge_send',
    description: 'Send a concrete message across sessions. The bridge does not transfer task ownership: the sender remains responsible for its task unless the message explicitly assigns a bounded independent subtask and the receiver accepts it. Do not offload your own unfinished work, send acknowledgements, or send placeholder status. Omit mode to steer now; use queue only for an intentional later turn.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Target ordinary session id used for routing.' },
        session_name: { type: 'string', description: 'Target session name copied from session_bridge_list for readable tool history; display only.' },
        message: { type: 'string', description: 'Text message to deliver.' },
        mode: { type: 'string', enum: ['steer', 'queue'], description: 'steer (default) targets the receiver now; queue intentionally starts a distinct later turn.' },
      },
      required: ['session_id', 'message'],
    },
    async execute(args, exec) {
      const caller = exec.agent
      if (!caller) throw new Error('session_bridge_send requires a calling agent')
      if (args.session_id === caller.id) throw new Error('target must be another session')
      const text = String(args.message ?? '').trim()
      if (!text) throw new Error('message must contain non-whitespace text')
      if (isBareAcknowledgement(text)) throw new Error('bare acknowledgements are suppressed; send only material progress, blockers, decisions, or final results')
      let target = ctx.agents.get(args.session_id)
      if (!target) target = (await ctx.agents.resume({ resumeSessionId: args.session_id })).agent
      const msg = agentMessage(caller, text)
      const placement = args.mode ?? 'steer'
      if (placement === 'steer') target.steer(msg)
      else target.followup(msg)
      const reportKey = `${caller.id}\u0000${args.session_id}`
      reportEpochs.set(reportKey, (reportEpochs.get(reportKey) ?? 0) + 1)
      const sessionName = String(args.session_name ?? '').trim() || titleFrom(
        typeof target.session?.snapshotEvents === 'function' ? target.session.snapshotEvents() : [],
        String(args.session_id),
      )
      return `Message ${msg.id} delivered to ${sessionName} (${args.session_id}; ${placement}; visible after the target Agent consumes it).`
    },
  }))
}
