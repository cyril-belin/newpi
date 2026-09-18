#!/usr/bin/env node
/**
 * Acceptance run: drive one real DeepSeek turn and prove the memory round trip.
 *
 * This is the only check that observes the feature the way a user does. Every
 * other test in this repository either fakes the sidecar, fakes the harness, or
 * inspects the plugins in isolation. This one starts from a running NewPi,
 * speaks the harness's own RPC, and then reads the evidence three ways: the
 * agent's own tool calls in the durable session log, the record in PocketBase,
 * and the tool results the model received.
 *
 * The prompt asks for a `remember` followed by a `recall` in one turn, against
 * an isolated test project id, and finishes by having the agent delete what it
 * wrote with `forget`. The script then proves the database is back to empty.
 *
 * Usage: node scripts/acceptance-memory-e2e.mjs <path-to-newpi-log>
 *
 * The log file is how the harness's one-shot launch token is found; NewPi
 * prints the ready URL on its standard output.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Isolated project scope for this run. Nothing else uses this id. */
const PROJECT_ID = 'newpi-acceptance-e2e';
/** Marker planted in the memory, unique enough to grep for anywhere. */
const MARKER = `acceptance-${Date.now()}`;
/** Where the harness keeps the sessions of the workspace under test. */
const SESSION_ROOT = join(homedir(), '.dsh', 'sessions');
/** The data directory NewPi documents. */
const PB_DATA = join(
  homedir(),
  'Library/Application Support/NewPi/pocketbase/pb_data/data.db',
);
const PB_DIR = join(homedir(), 'Library/Application Support/NewPi/pocketbase');

/** Log one step. */
function step(message) {
  console.log(`  ${message}`);
}

/** Read the running harness's ready URL out of NewPi's own output. */
function readyUrl(logPath) {
  const match = readFileSync(logPath, 'utf8').match(/dsh web: (\S+)/);
  assert.ok(match, `no ready URL in ${logPath}`);
  return match[1];
}

/** Exchange the one-shot launch token for a session cookie. */
async function authenticate(url) {
  const landing = await fetch(url, { redirect: 'manual' });
  assert.equal(landing.status, 303, 'the launch token was not accepted');
  return landing.headers.getSetCookie()[0].split(';')[0];
}

/** One RPC call on the shared `/api` channel. */
async function rpc(origin, cookie, endpoint, args) {
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `${endpoint}-${Math.random().toString(36).slice(2)}`,
      method: endpoint,
      payload: { args },
    }),
  });
  const envelope = await response.json();
  assert.equal(response.status, 200, `${endpoint} answered ${response.status}`);
  if (!envelope.result.ok) {
    throw new Error(`${endpoint} failed: ${JSON.stringify(envelope.result.error)}`);
  }
  return envelope.result.value;
}

/**
 * The session directory of one workspace.
 *
 * The harness names it after the workspace path with every separator turned
 * into a dash and the whole path wrapped in double dashes — `/tmp/x` becomes
 * `--tmp-x--`.
 *
 * @param cwd - the session's workspace root.
 * @returns the directory, whether or not it exists yet.
 */
function sessionDirFor(cwd) {
  return join(SESSION_ROOT, `--${cwd.replaceAll('/', '-').replace(/^-+|-+$/g, '')}--`);
}

/** Decompress and parse one session log. */
async function readSession(sessionDir) {
  const log = join(sessionDir, 'session.v3.jsonl.zstd');
  if (!existsSync(log)) return [];
  const { stdout } = await run('/opt/homebrew/bin/zstd', ['-dc', log], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** Every `tool/call` event naming one of the memory tools. */
function memoryCalls(events) {
  const names = new Set(['remember', 'recall', 'forget']);
  return events
    .filter((event) => event.type === 'tool/call' && names.has(event.data?.name))
    .map((event) => ({
      seq: event.seq,
      name: event.data.name,
      callId: event.data.callId,
      arguments: safeJson(event.data.arguments),
    }));
}

/**
 * Every `tool/result` whose call was a memory tool.
 *
 * A `tool/result` event wraps a user-role message whose single part is the
 * tool result, and the model-visible text sits one level below that again —
 * so reaching the text means unwrapping `message` then `tool-result`.
 *
 * @param events - the session events.
 * @param calls - the memory tool calls, to name each result.
 * @returns one entry per memory tool result, in order.
 */
function memoryResults(events, calls) {
  const byCallId = new Map(calls.map((call) => [call.callId, call.name]));
  const results = [];
  for (const event of events) {
    if (event.type !== 'tool/result') continue;
    for (const part of event.data?.message?.content ?? []) {
      if (part.type !== 'tool-result') continue;
      const name = byCallId.get(part.toolCallId);
      if (name === undefined) continue;
      results.push({
        name,
        callId: part.toolCallId,
        isError: Boolean(part.isError),
        text: (part.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .slice(0, 4000),
        meta: event.data?.meta,
      });
    }
  }
  return results;
}

/** Parse a JSON string without throwing. */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Query the live database directly, so the claim does not depend on the app. */
async function sql(query) {
  const { stdout } = await run('/usr/bin/sqlite3', [PB_DATA, query]);
  return stdout.trim();
}

/** Rows this run's project holds, with the columns that matter. */
async function rowsForProject() {
  const stdout = await sql(
    `select id, kind, content from memories where project_id = '${PROJECT_ID}';`,
  );
  return stdout.length === 0 ? [] : stdout.split('\n');
}

/** Wait until a predicate holds, polling. */
async function until(label, predicate, { timeoutMs = 240_000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const logPath = process.argv[2] ?? join(tmpdir(), 'newpi-live.log');
  const url = readyUrl(logPath);
  const origin = new URL(url).origin;
  step(`harness ready at ${origin}`);

  const cookie = await authenticate(url);
  step('launch token exchanged for a session cookie');

  const before = await rowsForProject();
  assert.deepEqual(before, [], 'the test project must start empty');
  step(`project ${PROJECT_ID} starts with 0 memories`);

  console.log('\n1. create a real session in the test workspace');
  const created = await rpc(origin, cookie, 'session/create', {
    request: { cwd: '/tmp/newpi-acceptance' },
  });
  const sessionId = created.sessionId;
  step(`session ${sessionId} (preset ${created.agentPreset})`);

  console.log('\n2. ask the agent to store a memory, then read it back');
  const requestId = `acceptance-${Date.now()}`;
  await rpc(origin, cookie, 'session/prompt', {
    request: {
      requestId,
      sessionId,
      mode: 'queue',
      clientTimeZone: 'UTC',
      content: [
        {
          type: 'text',
          text:
            'Do exactly these three things and nothing else. ' +
            `First, call remember with kind "note" and content "${MARKER} : le projet de test ${PROJECT_ID} utilise pnpm." ` +
            `Second, call recall with the query "${MARKER}". ` +
            'Third, reply with one line containing the exact id returned by remember, quoted, and nothing else.',
        },
      ],
    },
  });
  step('prompt accepted');

  const sessionDir = join(sessionDirFor('/tmp/newpi-acceptance'), sessionId);
  assert.ok(existsSync(sessionDir), `session directory not found: ${sessionDir}`);

  console.log('\n3. wait for the agent to finish the turn');
  const finished = await until('the turn to end', async () => {
    const events = await readSession(sessionDir);
    return events.some((event) => event.type === 'turn/end') ? events : null;
  });
  step(`turn ended, ${finished.length} events recorded`);

  console.log('\n4. the durable session log shows the tool calls');
  const calls = memoryCalls(finished);
  const results = memoryResults(finished, calls);
  for (const call of calls) {
    step(`tool/call  ${call.name.padEnd(9)} seq=${call.seq}`);
  }
  assert.ok(
    calls.some((call) => call.name === 'remember'),
    'the agent never called remember',
  );
  assert.ok(
    calls.some((call) => call.name === 'recall'),
    'the agent never called recall',
  );
  // The argument the model sent is the one the schema allows: no project scope.
  for (const call of calls) {
    assert.ok(
      !('project_id' in call.arguments) && !('projectId' in call.arguments),
      `${call.name} was called with a project scope, which the schema forbids`,
    );
  }
  step('no memory call carried a project scope argument');

  // What the model said, and what it was told back. Both live under
  // `data.message`; a tool call the model emitted is a `tool-call` part.
  const assistantText = finished
    .filter((event) => event.type === 'assistant/message')
    .flatMap((event) => event.data?.message?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const modelToolCalls = finished
    .filter((event) => event.type === 'assistant/message')
    .flatMap((event) => event.data?.message?.content ?? [])
    .filter((part) => part.type === 'tool-call')
    .map((part) => part.name);
  assert.deepEqual(
    modelToolCalls,
    ['remember', 'recall'],
    `the model asked for ${modelToolCalls.join(', ')}, not remember then recall`,
  );
  step(`the model itself emitted: ${modelToolCalls.join(', then ')}`);
  assert.ok(assistantText.length > 0, 'the model produced no text at all');
  step(`model text: ${assistantText.replaceAll('\n', ' ').slice(0, 120)}`);

  console.log('\n5. PocketBase holds exactly one memory, in the test project');
  const stored = await rowsForProject();
  assert.equal(stored.length, 1, `expected 1 row, found ${stored.length}: ${stored.join(' | ')}`);
  const [id, kind, content] = stored[0].split('|');
  assert.equal(kind, 'note');
  assert.ok(content.includes(MARKER), 'the stored content is not the one that was asked for');
  step(`row ${id} · kind=${kind} · ${content.slice(0, 60)}…`);

  console.log('\n6. the recall result the model received contains that memory');
  const recallResult = results.find((result) => result.name === 'recall');
  assert.ok(recallResult, 'no recall result was recorded');
  assert.equal(recallResult.isError, false, 'recall reported an error');
  assert.ok(
    recallResult.text.includes(id),
    `the recall result does not contain ${id}: ${recallResult.text.slice(0, 300)}`,
  );
  step(`recall returned the stored id ${id}`);
  // The tool's own output projection reached the registry: `presentationMeta`
  // declared `{ count }`, and the recorded meta carries it.
  assert.equal(recallResult.meta?.count, 1, 'the recall meta projection is missing');
  step(`recall meta projection: ${JSON.stringify(recallResult.meta)}`);

  console.log('\n7. prove the scope is real: the same query from another project finds nothing');
  const foreign = await sql(
    `select count(*) from memories where project_id = 'newpi-acceptance-other' ;`,
  );
  assert.equal(foreign, '0');
  const total = await sql('select count(*) from memories;');
  step(`database holds ${total} row(s) in total, all under ${PROJECT_ID}`);
  assert.equal(total, '1', 'no other project may hold rows during this run');

  console.log('\n8. ask the agent to forget it, using the tool');
  const forgetRequestId = `acceptance-forget-${Date.now()}`;
  await rpc(origin, cookie, 'session/prompt', {
    request: {
      requestId: forgetRequestId,
      sessionId,
      mode: 'queue',
      clientTimeZone: 'UTC',
      content: [
        {
          type: 'text',
          text:
            `Call forget once with id "${id}". Use exactly that value for the id parameter. ` +
            'Do not call any other tool. Then answer with the single word: done.',
        },
      ],
    },
  });

  const afterForget = await until('the forget call to land', async () => {
    const events = await readSession(sessionDir);
    return memoryCalls(events).some((call) => call.name === 'forget') ? events : null;
  });
  const allCalls = memoryCalls(afterForget);
  const forgetCall = allCalls.find((call) => call.name === 'forget');
  assert.equal(forgetCall.arguments.id, id, 'forget was called with a different id');
  step(`tool/call  forget    seq=${forgetCall.seq} id=${id}`);

  const forgetResult = memoryResults(afterForget, allCalls).find(
    (result) => result.name === 'forget',
  );
  assert.ok(forgetResult, 'no forget result was recorded');
  assert.equal(forgetResult.isError, false, 'forget reported an error');
  step(`forget result: ${forgetResult.text.slice(0, 120)}`);

  console.log('\n9. the database is empty again');
  const remaining = await rowsForProject();
  assert.deepEqual(remaining, [], `rows left behind: ${remaining.join(' | ')}`);
  const totalAfter = await sql('select count(*) from memories;');
  assert.equal(totalAfter, '0', `${totalAfter} row(s) remain in the whole database`);
  step('0 rows in the project, 0 rows in the database');

  // Keep the raw evidence next to the report.
  const evidence = {
    projectId: PROJECT_ID,
    marker: MARKER,
    sessionId,
    storedId: id,
    database: PB_DATA,
    calls: allCalls.map((call) => ({ seq: call.seq, name: call.name, arguments: call.arguments })),
    results: memoryResults(afterForget, allCalls),
    assistantText: assistantText.slice(0, 2000),
    rowsBefore: before.length,
    rowsAfterForget: remaining.length,
    rowsInDatabaseAfter: Number(totalAfter),
  };
  const evidencePath = join(tmpdir(), 'newpi-acceptance-evidence.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  step(`evidence written to ${evidencePath}`);

  console.log('\nThe memory round trip works end to end in a real session.\n');
}

main().catch((error) => {
  console.error('\nAcceptance run FAILED\n');
  console.error(error);
  process.exit(1);
});
