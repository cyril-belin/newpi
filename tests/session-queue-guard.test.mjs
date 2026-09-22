/** The session queue guard keeps status messages from cancelling active work. */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apply,
  installSessionQueueGuard,
  name,
  queuePromptRequest,
} from '../plugins/session-queue-guard/index.js'

test('only a steering prompt becomes queued', () => {
  const steering = { requestId: 'request-1', mode: 'steer', content: [{ type: 'text', text: 'continue' }] }
  assert.deepEqual(queuePromptRequest(steering), {
    requestId: 'request-1',
    mode: 'queue',
    content: [{ type: 'text', text: 'continue' }],
  })
  assert.equal(steering.mode, 'steer', 'the incoming request is immutable to the guard')
  const queued = { mode: 'queue' }
  assert.equal(queuePromptRequest(queued), queued)
  assert.equal(queuePromptRequest('not a request'), 'not a request')
})

test('the controller guard queues every admitted steering prompt', async () => {
  const calls = []
  const controller = {
    prompt(request, signal) {
      calls.push({ request, signal, receiver: this })
      return Promise.resolve({ accepted: true })
    },
  }

  assert.equal(installSessionQueueGuard(controller), true)
  assert.equal(installSessionQueueGuard(controller), false, 'a second mount cannot double-wrap admission')
  await controller.prompt({ mode: 'steer' }, 'signal')
  await controller.prompt({ mode: 'queue' })

  assert.equal(calls[0].request.mode, 'queue')
  assert.equal(calls[0].signal, 'signal')
  assert.equal(calls[0].receiver, controller)
  assert.equal(calls[1].request.mode, 'queue')
})

test('the plugin mounts the controller guard and announces itself', () => {
  const messages = []
  const controller = { prompt() {} }
  apply({
    sessionController: controller,
    logger: { info(message) { messages.push(message) } },
  })
  assert.equal(messages[0], `${name}: user prompts queue behind active work`)
  assert.equal(installSessionQueueGuard(controller), false)
})
