import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'vivi-consumer-'))
const cache = process.env.VIVI_TEST_NPM_CACHE ?? join(tmpdir(), 'vivi-npm-cache')

function run(command, arguments_, cwd = root) {
  const result = spawnSync(command, arguments_, {
    cwd, encoding: 'utf8',
    env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' }
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary, '--cache', cache]))
  const paths = new Set(packed.files.map((file) => file.path))
  for (const required of ['docs/AGENT_RECORDS.md', 'examples/agent-records.mjs', 'src/events.ts',
    'dist/events.js', 'dist/events.d.ts', 'dist/cjs/events.js', 'dist/cjs/events.d.ts']) {
    assert(paths.has(required), `Package is missing ${required}`)
  }
  for (const required of ['docs/AGENT_STREAM.md', 'examples/agent-stream.mjs', 'src/events/stream.ts',
    'dist/events/stream.js', 'dist/events/stream.d.ts', 'dist/cjs/events/stream.js', 'dist/cjs/events/stream.d.ts']) {
    assert(paths.has(required), `Package is missing ${required}`)
  }
  for (const required of ['docs/EXTENSION_SCOPES.md', 'examples/extension-scope.mjs']) {
    assert(paths.has(required), `Package is missing ${required}`)
  }
  for (const required of ['docs/MCP.md', 'src/extensions/mcp.ts', 'src/extensions/mcp/catalog.ts',
    'src/extensions/mcp/data.ts', 'src/extensions/mcp/operations.ts', 'src/extensions/mcp/content.ts',
    'examples/mcp.mjs', 'dist/extensions/mcp.js', 'dist/extensions/mcp.d.ts',
    'dist/cjs/extensions/mcp.js', 'dist/cjs/extensions/mcp.d.ts']) {
    assert(paths.has(required), `Package is missing ${required}`)
  }
  for (const required of ['docs/DECISIONS.md', 'src/decisions.ts', 'src/decisions/evaluate.ts',
    'src/decisions/providers.ts', 'src/decisions/types.ts', 'src/decisions/validation.ts', 'src/decisions/actions.ts',
    'examples/decisions.mjs', 'dist/decisions.js', 'dist/decisions.d.ts',
    'dist/cjs/decisions.js', 'dist/cjs/decisions.d.ts', 'dist/decisions/actions.js', 'dist/cjs/decisions/actions.js']) {
    assert(paths.has(required), `Package is missing ${required}`)
  }
  for (const required of ['docs/SKILLS.md', 'src/extensions/skills.ts', 'src/extensions/skills-creator.ts',
    'skills/skill-creator/SKILL.md', 'examples/skills.mjs', 'dist/extensions/skills.js',
    'dist/extensions/skills.d.ts', 'dist/cjs/extensions/skills.js', 'dist/cjs/extensions/skills.d.ts']) {
    assert(paths.has(required), `Package is missing ${required}`)
  }
  for (const required of ['docs/MEMORY.md', 'src/extensions/memory.ts', 'examples/memory.mjs',
    'dist/extensions/memory.js', 'dist/extensions/memory.d.ts',
    'dist/cjs/extensions/memory.js', 'dist/cjs/extensions/memory.d.ts']) {
    assert(paths.has(required), `Package is missing ${required}`)
  }
  for (const required of ['CAPABILITIES.md', 'src/providers/models.ts', 'examples/model-capabilities.mjs',
    'dist/providers/models.js', 'dist/providers/models.d.ts',
    'dist/cjs/providers/models.js', 'dist/cjs/providers/models.d.ts']) {
    assert(paths.has(required), `Package is missing ${required}`)
  }
  for (const required of ['LICENSE', 'NOTICE', 'ATTRIBUTION.md', 'README.md', 'CHANGELOG.md', 'RELEASING.md', 'docs/API.md', 'examples/headless.mjs', 'src/index.ts', 'src/run-agent.ts', 'src/types.ts', 'src/history.ts', 'src/providers/openai.ts', 'src/providers/openrouter.ts', 'src/extensions.ts', 'src/extensions/calculator.ts', 'tsconfig.json', 'tsconfig.cjs.json', 'scripts/clean-build.mjs', 'scripts/finish-build.mjs', 'dist/index.js', 'dist/index.d.ts', 'dist/providers/openai.js', 'dist/providers/openai.d.ts', 'dist/providers/openrouter.js', 'dist/providers/openrouter.d.ts', 'dist/cjs/index.js', 'dist/cjs/index.d.ts', 'dist/cjs/providers/openai.js', 'dist/cjs/providers/openrouter.js', 'dist/cjs/package.json', 'dist/extensions.js', 'dist/extensions.d.ts', 'dist/extensions/calculator.js', 'dist/extensions/calculator.d.ts', 'dist/cjs/extensions.js', 'dist/cjs/extensions.d.ts', 'dist/cjs/extensions/calculator.js', 'dist/cjs/extensions/calculator.d.ts']) {
    assert(paths.has(required), `Package is missing ${required}`)
  }
  assert([...paths].every((path) => !path.includes('node_modules') && !path.startsWith('test/')))
  const tarball = join(temporary, packed.filename)
  const bytes = await readFile(tarball)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, tarball], temporary)
  const installed = join(temporary, 'node_modules/@ayayaq/vivi')
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@ayayaq/vivi')
  assert.equal(manifest.version, sourceManifest.version)
  assert.equal(packed.filename, `ayayaq-vivi-${sourceManifest.version}.tgz`)
  assert.equal(manifest.publishConfig.access, 'public')
  assert.deepEqual(manifest.exports, sourceManifest.exports)
  assert.deepEqual(manifest.exports['./decisions'], {
    import: { types: './dist/decisions.d.ts', default: './dist/decisions.js' },
    require: { types: './dist/cjs/decisions.d.ts', default: './dist/cjs/decisions.js' }
  })
  run(process.execPath, [join(installed, 'examples/extension-scope.mjs')], temporary)
  run(process.execPath, [join(installed, 'examples/mcp.mjs')], temporary)
  run(process.execPath, [join(installed, 'examples/decisions.mjs')], temporary)
  run(process.execPath, [join(installed, 'examples/headless.mjs')], temporary)
  assert.deepEqual(manifest.exports['./extensions/mcp'], {
    import: { types: './dist/extensions/mcp.d.ts', default: './dist/extensions/mcp.js' },
    require: { types: './dist/cjs/extensions/mcp.d.ts', default: './dist/cjs/extensions/mcp.js' }
  })
  assert.equal(manifest.license, 'Apache-2.0')
  assert.deepEqual(manifest.dependencies, {yaml:'2.9.1'})
  const yamlManifest = JSON.parse(await readFile(join(temporary, 'node_modules/yaml/package.json'), 'utf8'))
  assert.equal(yamlManifest.version, '2.9.1')
  assert.equal(yamlManifest.license, 'ISC')
  const yamlLicense = await readFile(join(temporary, 'node_modules/yaml/LICENSE'), 'utf8')
  assert(yamlLicense.includes('Copyright Eemeli Aro'))
  assert(yamlLicense.includes('Permission to use, copy, modify, and/or distribute'))
  const consumerLock = JSON.parse(await readFile(join(temporary, 'package-lock.json'), 'utf8'))
  assert(!Object.keys(consumerLock.packages).some(path => path.includes('node_modules/@modelcontextprotocol/')), 'Host SDK must not be a runtime dependency')
  assert.equal(consumerLock.packages['node_modules/yaml'].resolved, 'https://registry.npmjs.org/yaml/-/yaml-2.9.1.tgz')
  assert.equal(consumerLock.packages['node_modules/yaml'].integrity, 'sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==')
  assert.deepEqual(manifest.exports['./providers/models'], {
    import: { types: './dist/providers/models.d.ts', default: './dist/providers/models.js' },
    require: { types: './dist/cjs/providers/models.d.ts', default: './dist/cjs/providers/models.js' }
  })
  assert.deepEqual(await readFile(join(installed, 'LICENSE')), await readFile(join(root, 'LICENSE')))
  assert((await readFile(join(installed, 'LICENSE'), 'utf8')).includes('Version 2.0, January 2004'))
  assert((await readFile(join(installed, 'ATTRIBUTION.md'), 'utf8')).includes('943e3f84f67e4415a899da8921db84639843c625'))
  for (const [extension, importLine] of [
    ['mjs', "import * as mcp from '@ayayaq/vivi/extensions/mcp'\nimport assert from 'node:assert/strict'"],
    ['cjs', "const mcp = require('@ayayaq/vivi/extensions/mcp')\nconst assert = require('node:assert/strict')"]
  ]) {
    await writeFile(join(temporary, `mcp-consumer.${extension}`), `${importLine}
;(async () => {
  const signal = new AbortController().signal
  const compile = schema => { assert.equal(schema.type,'object'); return value => { assert.equal(typeof value.query,'string') } }
  const category = await mcp.collectMcpCategory('fixture','tools',async () => ({tools:[{name:'echo/name',inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}}]}),signal,compile)
  const snapshot = {serverId:'fixture',configRevision:'config-1',connectionGeneration:'connection-1',protocolVersion:'legacy',catalogGeneration:1,categories:{tools:category,resources:mcp.emptyMcpCategory(),resourceTemplates:mcp.emptyMcpCategory()}}
  const entry = category.entries[0], call = {id:'call-1',name:entry.alias,arguments:{query:'offline'}}
  const operation = mcp.prepareMcpOperation(snapshot,entry,'tools',call,'launch-1',compile)
  mcp.assertMcpOperationCurrent(operation,snapshot,'launch-1',true,'config-1')
  const host = {async captureCatalogs(){return [snapshot]},prepareOperation(){return operation}}
  let reviews = 0
  const extension = mcp.createMcpExtension(host,[snapshot],async () => {reviews++;return mcp.mcpFailure('unknown','Synthetic unknown outcome',true)},{validateSchema:compile,assertAllowed(){}})
  const result = await extension.tools[0].execute(call,{signal})
  assert.equal(reviews,1);assert.equal(JSON.parse(result.content).doNotRetry,true)
  const projected = mcp.projectMcpResult('fixture','tools/call','echo/name',{content:[{type:'image',mimeType:'image/png',data:'omitted'}]},()=>{})
  assert.equal(JSON.parse(projected.content).content[0].binaryOmitted,true)
})().catch(error => {console.error(error);process.exitCode=1})
`)
    run(process.execPath, [`mcp-consumer.${extension}`], temporary)
  }
  run(process.execPath, [join(installed, 'examples/agent-records.mjs')], temporary)
  run(process.execPath, [join(installed, 'examples/agent-stream.mjs')], temporary)
  assert.deepEqual(manifest.exports['./events/stream'], {
    import: { types: './dist/events/stream.d.ts', default: './dist/events/stream.js' },
    require: { types: './dist/cjs/events/stream.d.ts', default: './dist/cjs/events/stream.js' }
  })
  for (const [extension, importLine] of [
    ['mjs', "import * as stream from '@ayayaq/vivi/events/stream'\nimport * as events from '@ayayaq/vivi/events'\nimport {runAgent} from '@ayayaq/vivi'\nimport assert from 'node:assert/strict'"],
    ['cjs', "const stream=require('@ayayaq/vivi/events/stream')\nconst events=require('@ayayaq/vivi/events')\nconst {runAgent}=require('@ayayaq/vivi')\nconst assert=require('node:assert/strict')"]
  ]) {
    await writeFile(join(temporary, `stream-consumer.${extension}`), `${importLine}
;(async () => {
  const source={reference:'host/packed-stream',revision:'1'}, base=events.createAgentProjection('stream-packed')
  let state=stream.createAgentRunProjection(base,'run'); const records=[]
  const header=()=>({version:1,scope:'run',sessionId:base.sessionId,runId:'run',eventId:'event-'+(state.sequence+1),sequence:state.sequence+1,previousEventId:state.eventId,source})
  const append=record=>{state=stream.applyAgentRunRecord(state,record);records.push(record)}
  append(stream.createAgentRunStart(header(),base,[]))
  const result=await runAgent({messages:[],tools:[],provider:{async generate(){return {content:'Packed stream',toolCalls:[],usage:{inputTokens:3,outputTokens:1,totalTokens:5}}}},async executeTool(){throw new Error('No tools')},onAccepted(update){assert(Object.isFrozen(update.message));append(stream.createAgentAcceptedRecord({envelope:header(),update,historyId:'original-assistant-id',source}))}})
  const terminal=events.createRunSettlement({envelope:{version:1,sessionId:base.sessionId,eventId:'session-terminal',sequence:1,previousEventId:null,source},runId:'run',inputHistoryLength:0,result,history:state.history,outcomes:[],sessionUsage:result.usage})
  append(stream.createAgentRunTerminal(header(),terminal))
  assert.deepEqual(state,stream.projectAgentRunRecords(base,'run',records));assert.equal(state.state,'settled');assert.equal(state.runUsage.totalTokens,5)
  assert.equal(stream.applyAgentRunRecord(state,records[0]),state)
})().catch(error=>{console.error(error);process.exitCode=1})
`)
    run(process.execPath, [`stream-consumer.${extension}`], temporary)
  }
  for (const [extension, importLine] of [
    ['mts', "import * as stream from '@ayayaq/vivi/events/stream'\nimport * as events from '@ayayaq/vivi/events'\nimport * as core from '@ayayaq/vivi'"],
    ['cts', "import stream=require('@ayayaq/vivi/events/stream')\nimport events=require('@ayayaq/vivi/events')\nimport core=require('@ayayaq/vivi')"]
  ]) {
    await writeFile(join(temporary, `stream-types.${extension}`), `${importLine}
const base: events.AgentProjection=events.createAgentProjection('typed')
const state: stream.AgentRunProjection=stream.createAgentRunProjection(base,'run')
const header: stream.AgentRunRecordEnvelope={version:1,scope:'run',sessionId:'typed',runId:'run',eventId:'event',sequence:1,previousEventId:null,source:{reference:'host/source'}}
const record: stream.AgentRunRecord=stream.createAgentRunStart(header,base,[])
const restored: stream.AgentRunProjection=stream.projectAgentRunRecords(base,'run',[record])
const update: core.AgentAcceptedUpdate={type:'assistant_accepted',message:{kind:'assistant',content:'Typed',toolCalls:[]},round:1,aggregateUsage:{inputTokens:0,outputTokens:0,totalTokens:0}}
void stream.createAgentAcceptedRecord({envelope:header,update,historyId:'original-id',source:header.source})
const options: core.RunAgentOptions={messages:[],tools:[],provider:{async generate(){return {content:'Typed',toolCalls:[]}}},async executeTool(){return {content:''}},onAccepted(accepted){if(accepted.type==='assistant_accepted'){const total:number=accepted.aggregateUsage.totalTokens;void total}}}
void core.runAgent(options);void state;void stream.AGENT_RUN_RECORD_LIMITS
// @ts-expect-error projected canonical history is deeply immutable
restored.history[0]!.message.content='changed'
// @ts-expect-error run state cursor is immutable
restored.sequence=2
// @ts-expect-error unsupported run namespace
header.scope='session'
// @ts-expect-error canonical acceptance is not a transient progress event
const progress: core.AgentAcceptedUpdate={type:'progress',text:'partial'}
void progress
`)
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', `stream-types.${extension}`], temporary)
  }
  for (const [extension, importLine] of [
    ['mjs', "import * as events from '@ayayaq/vivi/events'\nimport assert from 'node:assert/strict'"],
    ['cjs', "const events = require('@ayayaq/vivi/events')\nconst assert = require('node:assert/strict')"]
  ]) {
    await writeFile(join(temporary, `events-consumer.${extension}`), `${importLine}
const source = {reference:'host/packed-fixture',revision:'1'}
const result = {status:'completed',history:[{kind:'assistant',content:'Packed terminal',toolCalls:[]}],content:'Packed terminal',rounds:1,usage:{inputTokens:3,outputTokens:1,totalTokens:5}}
const record = events.createRunSettlement({envelope:{version:1,sessionId:'packed',eventId:'packed-event',sequence:1,previousEventId:null,source},runId:'packed-run',inputHistoryLength:0,result,history:result.history.map((message,index)=>({id:'message-'+index,source,message})),outcomes:[],sessionUsage:result.usage})
const projected = events.projectAgentRecords('packed',[record])
assert.deepEqual(projected,events.applyAgentRecord(events.createAgentProjection('packed'),record))
assert.equal(events.applyAgentRecord(projected,record),projected)
assert.equal(projected.usage.totalTokens,5)
assert(Object.isFrozen(projected.history[0].message))
assert.throws(()=>events.decodeAgentRecord({...record,version:2}))
`)
    run(process.execPath, [`events-consumer.${extension}`], temporary)
  }
  for (const [extension, importLine] of [
    ['mts', "import * as events from '@ayayaq/vivi/events'"],
    ['cts', "import events = require('@ayayaq/vivi/events')"]
  ]) {
    await writeFile(join(temporary, `events-types.${extension}`), `${importLine}
const projection: events.AgentProjection = events.createAgentProjection('typed')
const envelope: events.AgentRecordEnvelope = {version:1,sessionId:'typed',eventId:'typed-event',sequence:1,previousEventId:null,source:{reference:'host/source'}}
const record: events.DurableAgentRecord = {...envelope,type:'session_snapshot',reason:'legacy_import',snapshot:{history:[],outcomes:[],usage:{inputTokens:0,outputTokens:0,totalTokens:0}}}
const decoded: events.DurableAgentRecord = events.decodeAgentRecord(record)
const folded: events.AgentProjection = events.applyAgentRecord(projection,decoded)
// @ts-expect-error observation cursor is immutable
folded.sequence = 1
// @ts-expect-error deeply immutable projected history
folded.history[0]!.message.content = 'changed'
// @ts-expect-error immutable projected usage
folded.usage.totalTokens = 1
// @ts-expect-error unsupported schema version
envelope.version = 2
// @ts-expect-error evidence must identify exact host source/run/call/arguments and effect
const missingEvidence: events.AgentOutcomeEvidence = {callId:'call',name:'tool',status:'succeeded'}
void missingEvidence; void events.AGENT_RECORD_LIMITS
`)
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', `events-types.${extension}`], temporary)
  }
  await writeFile(join(temporary, 'consumer.mjs'), `
import assert from 'node:assert/strict'
import { runAgent } from '@ayayaq/vivi'
let calls = 0
const result = await runAgent({
  provider: { async generate({ messages }) {
    return messages.some(message => message.kind === 'tool_result')
      ? { content: 'Stock: 7', toolCalls: [] }
      : { content: '', toolCalls: [{ id: 'inventory-1', name: 'inventory', arguments: { sku: 'pencil' } }] }
  } },
  messages: [{ kind: 'message', role: 'user', content: 'How many pencils?' }],
  tools: [{ name: 'inventory', description: 'Look up stock', parameters: { type: 'object' } }],
  async executeTool(call) { assert.equal(call.arguments.sku, 'pencil'); calls++; return { content: '7' } }
})
assert.equal(result.status, 'completed')
assert.equal(result.content, 'Stock: 7')
assert.equal(calls, 1)
assert.equal(result.rounds, 2)
`)
  run(process.execPath, ['consumer.mjs'], temporary)
  await writeFile(join(temporary, 'consumer.cjs'), `
const assert = require('node:assert/strict')
const { runAgent } = require('@ayayaq/vivi')
;(async () => {
  const result = await runAgent({
    provider: { async generate() { return { content: 'CommonJS works', toolCalls: [] } } },
    messages: [], tools: [], async executeTool() { throw new Error('No tools expected') }
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.content, 'CommonJS works')
})().catch(error => { console.error(error); process.exitCode = 1 })
`)
  run(process.execPath, ['consumer.cjs'], temporary)
  await writeFile(join(temporary, 'extensions.mjs'), `
import assert from 'node:assert/strict'
import { runAgent } from '@ayayaq/vivi'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import { calculatorExtension } from '@ayayaq/vivi/extensions/calculator'
const registry = createToolRegistry([calculatorExtension])
const output = await registry.executeTool({id:'calc',name:'calculate',arguments:{expression:'2*(3+4)'}},{signal:new AbortController().signal})
assert.deepEqual(JSON.parse(output.content),{result:14})
const result = await runAgent({provider:{async generate({messages}){
 return messages.some(message=>message.kind==='tool_result')
  ? {content:'14',toolCalls:[]}
  : {content:'',toolCalls:[{id:'calc',name:'calculate',arguments:{expression:'2*(3+4)'}}]}
}},messages:[],tools:registry.tools,executeTool:registry.executeTool})
assert.equal(result.status,'completed')
assert.equal(result.content,'14')
`)
  run(process.execPath, ['extensions.mjs'], temporary)
  await writeFile(join(temporary, 'extensions.cjs'), `
const assert = require('node:assert/strict')
const {createToolRegistry} = require('@ayayaq/vivi/extensions')
const {calculatorExtension,calculate} = require('@ayayaq/vivi/extensions/calculator')
assert.equal(calculate('4/2'),2)
;(async()=>{
 const registry=createToolRegistry([calculatorExtension])
 const result=await registry.executeTool({id:'calc',name:'calculate',arguments:{expression:'4/2'}},{signal:new AbortController().signal})
 assert.equal(result.content,'{"result":2}')
})().catch(error=>{console.error(error);process.exitCode=1})
`)
  run(process.execPath, ['extensions.cjs'], temporary)
  await writeFile(join(temporary, 'providers.mjs'), `
import assert from 'node:assert/strict'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
const openai = createOpenAIProvider({ apiKey: 'fake', model: 'fake', fetch: async () => new Response(JSON.stringify({ status:'completed', output:[{type:'message',id:'msg-1',role:'assistant',content:[{type:'output_text',text:'OpenAI',annotations:[]}]}] })) })
const router = createOpenRouterProvider({ apiKey: 'fake', model: 'fake', requireSupportedParameters: true,
  reasoning: {mode:'effort',effort:'high'}, supportedReasoningEfforts:['high'],
  fetch: async (_url, init) => {
    const body = JSON.parse(init.body)
    assert.deepEqual(body.provider, {require_parameters:true})
    assert.deepEqual(body.reasoning, {effort:'high',exclude:false})
    assert.equal(Object.hasOwn(body,'tools'), false)
    assert.equal(Object.hasOwn(body,'tool_choice'), false)
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'OpenRouter'}}]}))
  } })
assert.equal((await openai.generate({messages:[],tools:[]},new AbortController().signal)).content,'OpenAI')
assert.equal((await router.generate({messages:[],tools:[]},new AbortController().signal)).content,'OpenRouter')
`)
  run(process.execPath, ['providers.mjs'], temporary)
  await writeFile(join(temporary, 'providers.cjs'), `
const assert = require('node:assert/strict')
const { createOpenAIProvider } = require('@ayayaq/vivi/providers/openai')
const { createOpenRouterProvider } = require('@ayayaq/vivi/providers/openrouter')
assert.equal(typeof createOpenAIProvider({apiKey:'fake',model:'fake'}).generate,'function')
assert.equal(typeof createOpenRouterProvider({apiKey:'fake',model:'fake'}).generate,'function')
;(async () => {
  const provider = createOpenRouterProvider({apiKey:'fake',model:'fake',requireSupportedParameters:true,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body)
      assert.deepEqual(body.provider,{require_parameters:true})
      assert.equal(Object.hasOwn(body,'tool_choice'),false)
      assert.deepEqual(body.tools,[{type:'function',function:{name:'fixture',description:'Fixture',parameters:{type:'object'}}}])
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'CommonJS routing'}}]}))
    }})
  assert.equal((await provider.generate({messages:[],tools:[{name:'fixture',description:'Fixture',parameters:{type:'object'}}]},new AbortController().signal)).content,'CommonJS routing')
})().catch(error => { console.error(error); process.exitCode = 1 })
`)
  run(process.execPath, ['providers.cjs'], temporary)
  const modelsConsumer = `
const pro = normalizeModelCapabilities({apiVersion:1,provider:'openai',protocol:'responses',model:{id:'gpt-5-pro'}})
assert.equal(pro.chat,'supported')
assert.equal(pro.reasoning.requirement,'required')
assert.equal(reasoningSelectionSupport(pro,{mode:'default'}),'supported')
assert.equal(reasoningSelectionSupport(pro,{mode:'disabled'}),'unsupported')
assert.equal(normalizeModelCapabilities({apiVersion:1,provider:'openai',protocol:'chat-completions',model:{id:'gpt-5-pro'}}).chat,'unsupported')
const raw = {id:'vendor/model:free',supported_parameters:['tools'],architecture:{input_modalities:['text','image'],output_modalities:['text']},reasoning:{supports_max_tokens:true,mandatory:false}}
const before = JSON.stringify(raw)
const gateway = normalizeModelCapabilities({apiVersion:1,provider:'openrouter',protocol:'chat-completions',model:raw})
assert.equal(gateway.id,raw.id)
assert.equal(gateway.chat,'supported')
assert.equal(gateway.tools,'supported')
assert.equal(gateway.stream,'unknown')
assert.equal(gateway.reasoning.effortSelection,'unsupported')
assert.equal(gateway.reasoning.disable,'supported')
assert.deepEqual(gateway.reasoning.efforts,[])
assert.equal(reasoningSelectionSupport(gateway,{mode:'disabled'}),'supported')
assert.equal(JSON.stringify(raw),before)
assert(Object.isFrozen(gateway.reasoning.efforts))
const future = normalizeModelCapabilities({apiVersion:1,provider:'openai',protocol:'responses',model:{id:'gpt-5-future-snapshot'}})
assert.equal(future.chat,'unknown')
assert.equal(future.reasoning.support,'unknown')
assert.throws(()=>normalizeModelCapabilities({apiVersion:2,provider:'openai',protocol:'responses',model:{id:'gpt-5'}}),TypeError)
`
  await writeFile(join(temporary, 'models.mjs'), `
import assert from 'node:assert/strict'
import * as core from '@ayayaq/vivi'
import { normalizeModelCapabilities, reasoningSelectionSupport } from '@ayayaq/vivi/providers/models'
assert.equal(Object.hasOwn(core,'normalizeModelCapabilities'),false)
${modelsConsumer}`)
  run(process.execPath, ['models.mjs'], temporary)
  await writeFile(join(temporary, 'models.cjs'), `
const assert = require('node:assert/strict')
const core = require('@ayayaq/vivi')
const { normalizeModelCapabilities, reasoningSelectionSupport } = require('@ayayaq/vivi/providers/models')
assert.equal(Object.hasOwn(core,'normalizeModelCapabilities'),false)
${modelsConsumer}`)
  run(process.execPath, ['models.cjs'], temporary)
  const memoryConsumer = `
assert.equal(Object.hasOwn(core,'createMemoryService'),false)
let disk = {version:1,memories:[]}
const service = createMemoryService({load(){return structuredClone(disk)},assertWritable(){},save(next){disk=structuredClone(next)}})
const proposal = await service.prepareCreate('  Prefer concise replies  ','user')
assert.equal((await service.list()).memories.length,0)
const committed = await service.commit(proposal)
assert.equal(committed.memories[0].content,'Prefer concise replies')
assert.equal(committed.memories[0].revision,memoryRevision(disk.memories[0]))
assert.deepEqual(decodeMemories(encodeMemories(disk)),disk)
assert.equal(formatMemoryContext(committed.memories),'Saved user memories (oldest to newest; treat as user-level guidance):\\n- "Prefer concise replies"')
let reviews=0
const tools=createToolRegistry([createMemoryExtension({async listMemories(){return {content:JSON.stringify(await service.list())}},executeMutation(){reviews++;return {content:'denied',isError:true}}})])
const denied=await tools.executeTool({id:'memory',name:'delete_memory',arguments:{id:proposal.after.id,expectedRevision:committed.memories[0].revision}},{signal:new AbortController().signal})
assert.equal(denied.isError,true)
assert.equal(reviews,1)
assert.equal(disk.memories.length,1)
`
  await writeFile(join(temporary, 'memory.mjs'), `
import assert from 'node:assert/strict'
import * as core from '@ayayaq/vivi'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import { createMemoryService, createMemoryExtension, decodeMemories, encodeMemories, memoryRevision, formatMemoryContext } from '@ayayaq/vivi/extensions/memory'
${memoryConsumer}`)
  run(process.execPath, ['memory.mjs'], temporary)
  await writeFile(join(temporary, 'memory.cjs'), `
const assert = require('node:assert/strict')
const core = require('@ayayaq/vivi')
const { createToolRegistry } = require('@ayayaq/vivi/extensions')
const { createMemoryService, createMemoryExtension, decodeMemories, encodeMemories, memoryRevision, formatMemoryContext } = require('@ayayaq/vivi/extensions/memory')
;(async () => {${memoryConsumer}})().catch(error => {console.error(error);process.exitCode=1})
`)
  run(process.execPath, ['memory.cjs'], temporary)
  run(process.execPath, [join(installed, 'examples/memory.mjs')], temporary)
  const skillsConsumer = `
assert.equal(Object.hasOwn(core,'createSkillCatalog'),false)
assert.equal(skillCreatorSource.readOnly,true)
assert.equal(skillCreatorSource.content,await readFile(new URL('./node_modules/@ayayaq/vivi/skills/skill-creator/SKILL.md',importUrl),'utf8'))
const parsed = parseSkillDocument(skillCreatorSource.content,'skill-creator')
assert.equal(parsed.metadata.name,'skill-creator')
assert(Object.isFrozen(parsed.metadata))
const catalog = createSkillCatalog([skillCreatorSource])
assert(!formatSkillCatalogContext(catalog).includes('## Understand the workflow'))
const extension = createSkillsExtension({catalog,authorizeRead(){return true}})
const registry = createToolRegistry([extension])
assert.deepEqual(registry.tools.map(tool=>tool.name),['list_skills','read_skill'])
const listed = await registry.executeTool({id:'list',name:'list_skills',arguments:{}},{signal:new AbortController().signal})
assert.equal(JSON.parse(listed.content).skills[0].revision,parsed.revision)
const loaded = await registry.executeTool({id:'read',name:'read_skill',arguments:{name:'skill-creator',path:'SKILL.md',expectedRevision:parsed.revision}},{signal:new AbortController().signal})
assert.equal(JSON.parse(loaded.content).content,skillCreatorSource.content)
let written=false
const writing=createToolRegistry([createSkillsExtension({catalog,authorizeRead(){return true},save:{authorize(){return false},commit(){written=true}}})])
const blocked=await writing.executeTool({id:'save',name:'save_skill',arguments:{name:'skill-creator',content:skillCreatorSource.content,expectedRevision:parsed.revision}},{signal:new AbortController().signal})
assert.equal(blocked.isError,true)
assert.equal(written,false)
`
  await writeFile(join(temporary, 'skills.mjs'), `
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import * as core from '@ayayaq/vivi'
import {createToolRegistry} from '@ayayaq/vivi/extensions'
import {createSkillCatalog,createSkillsExtension,parseSkillDocument,formatSkillCatalogContext,skillCreatorSource} from '@ayayaq/vivi/extensions/skills'
const importUrl=import.meta.url
${skillsConsumer}`)
  run(process.execPath, ['skills.mjs'], temporary)
  await writeFile(join(temporary, 'skills.cjs'), `
const assert=require('node:assert/strict')
const {readFile}=require('node:fs/promises')
const {pathToFileURL}=require('node:url')
const core=require('@ayayaq/vivi')
const {createToolRegistry}=require('@ayayaq/vivi/extensions')
const {createSkillCatalog,createSkillsExtension,parseSkillDocument,formatSkillCatalogContext,skillCreatorSource}=require('@ayayaq/vivi/extensions/skills')
const importUrl=pathToFileURL(__filename)
;(async()=>{${skillsConsumer}})().catch(error=>{console.error(error);process.exitCode=1})
`)
  run(process.execPath, ['skills.cjs'], temporary)
  run(process.execPath, [join(installed, 'examples/skills.mjs')], temporary)
  const cacheConsumer = `
const baseUsage = {inputTokens:12,outputTokens:4,totalTokens:19}
const cacheUsage = {...baseUsage,cachedInputTokens:7,cacheWriteInputTokens:0}
const legacy = await runAgent({provider:{async generate(){return {content:'Legacy',toolCalls:[],usage:baseUsage}}},
  messages:[],tools:[],async executeTool(){throw Error('Unexpected tool')}})
assert.deepEqual(legacy.usage,baseUsage)
for (const [kind, factory] of [['openai',createOpenAIProvider],['openrouter',createOpenRouterProvider]]) {
  for (const stream of [false,true]) {
    const usage = kind === 'openai'
      ? {input_tokens:12,output_tokens:4,total_tokens:19,input_tokens_details:{cached_tokens:7,cache_write_tokens:0}}
      : {prompt_tokens:12,completion_tokens:4,total_tokens:19,prompt_tokens_details:{cached_tokens:7,cache_write_tokens:0}}
    const output = [{type:'message',id:'msg-1',role:'assistant',content:[{type:'output_text',text:'Cache',annotations:[]}]}]
    const body = kind === 'openai' ? {status:'completed',output,usage}
      : {choices:[{finish_reason:'stop',message:{role:'assistant',content:'Cache'}}],usage}
    const frame = value => 'data: ' + JSON.stringify(value) + '\\n\\n'
    const events = []
    const provider = factory({apiKey:'fake',model:'fake',stream,fetch:async () => {
      if (!stream) return new Response(JSON.stringify(body))
      const text = kind === 'openai' ? frame({type:'response.completed',response:body})
        : frame({choices:[{index:0,delta:{role:'assistant',content:'Cache'},finish_reason:'stop'}]}) +
          frame({choices:[],usage}) + 'data: [DONE]\\n\\n'
      return new Response(text,{headers:{'content-type':'text/event-stream'}})
    }})
    const turn = await provider.generate({messages:[],tools:[]},new AbortController().signal)
    assert.deepEqual(turn.usage,cacheUsage)
    const result = await runAgent({provider,messages:[],tools:[],async executeTool(){throw Error('Unexpected tool')},
      onEvent(event){if(event.type === 'round_completed') events.push(event.usage)}})
    assert.equal(result.status,'completed')
    assert.deepEqual(result.usage,cacheUsage)
    assert.deepEqual(events,[cacheUsage])
  }
}
`
  await writeFile(join(temporary, 'cache-consumer.mjs'), `
import assert from 'node:assert/strict'
import { runAgent } from '@ayayaq/vivi'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
${cacheConsumer}`)
  run(process.execPath, ['cache-consumer.mjs'], temporary)
  await writeFile(join(temporary, 'cache-consumer.cjs'), `
const assert = require('node:assert/strict')
const { runAgent } = require('@ayayaq/vivi')
const { createOpenAIProvider } = require('@ayayaq/vivi/providers/openai')
const { createOpenRouterProvider } = require('@ayayaq/vivi/providers/openrouter')
;(async () => {${cacheConsumer}})().catch(error => {console.error(error);process.exitCode = 1})
`)
  run(process.execPath, ['cache-consumer.cjs'], temporary)
  for (const [extension, importLine] of [
    ['mjs', "import {createExtensionScope} from '@ayayaq/vivi/extensions'\nimport {calculatorExtension} from '@ayayaq/vivi/extensions/calculator'\nimport assert from 'node:assert/strict'"],
    ['cjs', "const {createExtensionScope} = require('@ayayaq/vivi/extensions')\nconst {calculatorExtension} = require('@ayayaq/vivi/extensions/calculator')\nconst assert = require('node:assert/strict')"]
  ]) {
    await writeFile(join(temporary, `scope-consumer.${extension}`), `${importLine}
;(async () => {
  const scope = createExtensionScope({reservedNames:['disabled_host']})
  scope.register(calculatorExtension)
  const registry = scope.snapshot(), order = []
  scope.defer(() => {order.push('first')})
  scope.defer(async () => {await Promise.resolve();order.push('second')})
  const result = await registry.executeTool({id:'calc',name:'calculate',arguments:{expression:'3+4'}},{signal:new AbortController().signal})
  assert.equal(result.content,'{"result":7}')
  const disposed = scope.dispose()
  assert.equal(scope.signal.aborted,true)
  assert.equal(scope.dispose(),disposed)
  await disposed
  assert.deepEqual(order,['second','first'])
  assert.equal(scope.state,'closed')
  await assert.rejects(registry.executeTool({id:'late',name:'calculate',arguments:{expression:'1+1'}},{signal:new AbortController().signal}),{name:'AbortError'})
  const failed = createExtensionScope(), error = new Error('Cleanup failure')
  failed.defer(() => {throw error})
  const completion = failed.dispose()
  await assert.rejects(completion,value => value instanceof AggregateError && value.errors[0] === error)
  assert.equal(failed.dispose(),completion)
  assert.equal(failed.state,'closed')
})().catch(error => {console.error(error);process.exitCode=1})
`)
    run(process.execPath, [`scope-consumer.${extension}`], temporary)
  }
  for (const [extension, importLine] of [
    ['mts', "import * as extensions from '@ayayaq/vivi/extensions'"],
    ['cts', "import extensions = require('@ayayaq/vivi/extensions')"]
  ]) {
    await writeFile(join(temporary, `scope-types.${extension}`), `${importLine}
const reservedNames: readonly string[] = ['disabled_host']
const scope: extensions.ExtensionScope = extensions.createExtensionScope({reservedNames})
const cleanup: extensions.ExtensionCleanup = async () => {}
scope.defer(cleanup)
const state: 'open' | 'closing' | 'closed' = scope.state
const signal: AbortSignal = scope.signal
const snapshot: extensions.ToolRegistry = scope.snapshot()
const completion: Promise<void> = scope.dispose()
// @ts-expect-error owner state is readonly
scope.state = 'open'
// @ts-expect-error cleanup must resolve to void
scope.defer(async () => 1)
// @ts-expect-error unsupported extension version
scope.register({id:'invalid',apiVersion:2,tools:[]})
// @ts-expect-error reserved names are strings
extensions.createExtensionScope({reservedNames:[1]})
void state; void signal; void snapshot; void completion
`)
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', `scope-types.${extension}`], temporary)
  }
  await writeFile(join(temporary, 'consumer.ts'), `
import { runAgent, type AgentEvent, type AgentResult, type HistoryMessage, type JsonObject, type ModelProvider, type ToolCall, type ToolDefinition, type Usage } from '@ayayaq/vivi'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider, type OpenRouterProviderOptions } from '@ayayaq/vivi/providers/openrouter'
import { createToolRegistry, type ToolExtension, type ToolRegistry } from '@ayayaq/vivi/extensions'
import { calculatorExtension, calculate } from '@ayayaq/vivi/extensions/calculator'
import { createMemoryService, createMemoryExtension, decodeMemories, encodeMemories, type MemoryPersistence, type MemoryMutation, type MemoryListResult, type MemoryToolCall } from '@ayayaq/vivi/extensions/memory'
import {createSkillCatalog,createSkillsExtension,parseSkillDocument,skillCreatorSource, type SkillCatalog,type SkillDocument,type SkillSaveProposal,type SkillsExtensionHost} from '@ayayaq/vivi/extensions/skills'
const skillDocument: SkillDocument = parseSkillDocument(skillCreatorSource.content)
const skillCatalog: SkillCatalog = createSkillCatalog([skillCreatorSource])
const skillsHost: SkillsExtensionHost = {catalog:skillCatalog,authorizeRead(request,{signal}){signal.throwIfAborted();return request.name.length>0},save:{authorize(proposal:SkillSaveProposal){return proposal.after.revision.length>0},commit(proposal,{signal}){signal.throwIfAborted();void proposal}}}
const skillsExtension: ToolExtension = createSkillsExtension(skillsHost)
// @ts-expect-error mandatory host read policy
createSkillsExtension({catalog:skillCatalog})
// @ts-expect-error save must have both approval and commit capabilities
createSkillsExtension({catalog:skillCatalog,authorizeRead(){return true},save:{commit(){}}})
void skillDocument;void skillsExtension
import { normalizeModelCapabilities, reasoningSelectionSupport, type CapabilityInput, type ModelCapabilities, type Capability } from '@ayayaq/vivi/providers/models'
const persistence: MemoryPersistence = {load(){return decodeMemories('{"version":1,"memories":[]}')},assertWritable(){},save(data){encodeMemories(data)}}
const memoryService = createMemoryService(persistence)
const memoryProposal: MemoryMutation = await memoryService.prepareCreate('Concise','user')
const memoryList: MemoryListResult = await memoryService.commit(memoryProposal,{signal:new AbortController().signal})
const memoryExtension: ToolExtension = createMemoryExtension({async listMemories(){return {content:JSON.stringify(await memoryService.list())}},executeMutation(call: MemoryToolCall, {signal}){signal.throwIfAborted();return {content:call.name}}})
// @ts-expect-error service is not an approval callback host
createMemoryExtension(memoryService)
// @ts-expect-error attribution is limited to user or agent
memoryService.prepareCreate('Concise','system')
void memoryList; void memoryExtension
const modelInput: CapabilityInput = {apiVersion:1,provider:'openai',protocol:'responses',model:{id:'gpt-5.1'}}
const modelCapabilities: ModelCapabilities = normalizeModelCapabilities(modelInput)
const disableSupport: Capability = reasoningSelectionSupport(modelCapabilities,{mode:'disabled'})
// @ts-expect-error unsupported contract version
normalizeModelCapabilities({...modelInput,apiVersion:2})
// @ts-expect-error default is distinct from a named effort
reasoningSelectionSupport(modelCapabilities,{mode:'effort',effort:'default'})
// @ts-expect-error none uses the explicit disabled mode
reasoningSelectionSupport(modelCapabilities,{mode:'effort',effort:'none'})
void disableSupport
const pack: ToolExtension = calculatorExtension
const registry: ToolRegistry = createToolRegistry([pack], {reservedNames:['host_tool']})
const extensionRun: Promise<AgentResult> = runAgent({provider:{async generate(){return {content:String(calculate('1+1')),toolCalls:[]}}},messages:[],tools:registry.tools,executeTool:registry.executeTool})
// @ts-expect-error only extension API version 1 is supported
createToolRegistry([{...pack,apiVersion:2}])
void extensionRun
const openai: ModelProvider = createOpenAIProvider({apiKey:'fake',model:'fake',reasoning:{mode:'default'}})
const routerOptions: OpenRouterProviderOptions = {apiKey:'fake',model:'fake',stream:true,requireSupportedParameters:true}
const router: ModelProvider = createOpenRouterProvider(routerOptions)
// @ts-expect-error routing requires a boolean
createOpenRouterProvider({apiKey:'fake',model:'fake',requireSupportedParameters:'true'})
// @ts-expect-error OpenRouter routing is not an OpenAI option
createOpenAIProvider({apiKey:'fake',model:'fake',requireSupportedParameters:true})
void openai; void router
const parameters: JsonObject = { type: 'object' }
const tools: ToolDefinition[] = [{ name: 'inventory', description: 'Stock', parameters }]
const messages: HistoryMessage[] = [{ kind: 'message', role: 'user', content: 'Stock?' }]
const legacyUsage: Usage = {inputTokens:12,outputTokens:4,totalTokens:19}
const cacheUsage: Usage = {...legacyUsage,cachedInputTokens:7,cacheWriteInputTokens:0}
// @ts-expect-error cache counters must be numbers
const invalidUsage: Usage = {...legacyUsage,cachedInputTokens:'7'}
void invalidUsage
const provider: ModelProvider = { async generate(input, signal) {
  signal.throwIfAborted()
  return { content: String(input.messages.length), toolCalls: [], usage: cacheUsage, providerState: { provider: 'fake', items: [{ type: 'reasoning', content: 'opaque' }] } }
} }
const result: AgentResult = await runAgent({ provider, tools, messages,
  async executeTool(call: ToolCall, { signal }) { signal.throwIfAborted(); return { content: call.name } },
  onEvent(event: AgentEvent) {
    if (event.type === 'assistant') console.log(event.message.content)
    if (event.type === 'round_completed') {
      const read: number | undefined = event.usage?.cachedInputTokens
      const write: number | undefined = event.usage?.cacheWriteInputTokens
      void read; void write
    }
  }
})
const read: number | undefined = result.usage.cachedInputTokens
const write: number | undefined = result.usage.cacheWriteInputTokens
void read; void write
console.log(result.status)
`)
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', 'consumer.ts'], temporary)
  await writeFile(join(temporary, 'consumer.cts'), `
import core = require('@ayayaq/vivi')
import openai = require('@ayayaq/vivi/providers/openai')
import router = require('@ayayaq/vivi/providers/openrouter')
import extensions = require('@ayayaq/vivi/extensions')
import calculator = require('@ayayaq/vivi/extensions/calculator')
import models = require('@ayayaq/vivi/providers/models')
import memory = require('@ayayaq/vivi/extensions/memory')
import skills = require('@ayayaq/vivi/extensions/skills')
import mcp = require('@ayayaq/vivi/extensions/mcp')
const mcpCompiler: mcp.McpSchemaValidator = () => () => {}
const mcpExtension: extensions.ToolExtension = mcp.createMcpExtension({async captureCatalogs(){return []},prepareOperation(){throw new Error('No operation')}},[],async () => ({content:''}),{validateSchema:mcpCompiler,assertAllowed(){}})
// @ts-expect-error mandatory host privacy assertion
mcp.createMcpExtension({async captureCatalogs(){return []},prepareOperation(){throw new Error('No operation')}},[],async () => ({content:''}),{validateSchema:mcpCompiler})
void mcpExtension
const skillCatalog: skills.SkillCatalog = skills.createSkillCatalog([skills.skillCreatorSource])
const skillDocument: skills.SkillDocument = skills.parseSkillDocument(skills.skillCreatorSource.content)
const skillsExtension: extensions.ToolExtension = skills.createSkillsExtension({catalog:skillCatalog,authorizeRead(){return true}})
// @ts-expect-error mandatory host read policy
skills.createSkillsExtension({catalog:skillCatalog})
void skillDocument;void skillsExtension

const memoryService: memory.MemoryService = memory.createMemoryService({load(){return {version:1,memories:[]}},assertWritable(){},save(data){memory.encodeMemories(data)}})
const memoryList: Promise<memory.MemoryListResult> = memoryService.list()
const memoryExtension: extensions.ToolExtension = memory.createMemoryExtension({async listMemories(){return {content:JSON.stringify(await memoryService.list())}},executeMutation(call: memory.MemoryToolCall){return {content:call.name,isError:true}}})
// @ts-expect-error mandatory host mutation policy callback
memory.createMemoryExtension({listMemories(){return {content:''}}})
void memoryList; void memoryExtension
const modelCapabilities: models.ModelCapabilities = models.normalizeModelCapabilities({apiVersion:1,provider:'openrouter',protocol:'chat-completions',model:{id:'vendor/model'}})
const modelSupport: models.Capability = models.reasoningSelectionSupport(modelCapabilities,{mode:'default'})
// @ts-expect-error explicit API protocol required
models.normalizeModelCapabilities({apiVersion:1,provider:'openai',protocol:'auto',model:{id:'gpt-5'}})
void modelSupport
const registry: extensions.ToolRegistry = extensions.createToolRegistry([calculator.calculatorExtension])
const extensionRun: Promise<core.AgentResult> = core.runAgent({provider:{async generate(){return {content:'CJS extensions',toolCalls:[]}}},messages:[],tools:registry.tools,executeTool:registry.executeTool})
void extensionRun
const options: router.OpenRouterProviderOptions = {apiKey:'fake',model:'fake',requireSupportedParameters:true}
const shared: core.ModelProvider[] = [openai.createOpenAIProvider({apiKey:'fake',model:'fake'}),router.createOpenRouterProvider(options)]
// @ts-expect-error routing requires a boolean
router.createOpenRouterProvider({apiKey:'fake',model:'fake',requireSupportedParameters:1})
void shared
const provider: core.ModelProvider = { async generate() { return { content: 'CommonJS declarations work', toolCalls: [] } } }
const legacyUsage: core.Usage = {inputTokens:12,outputTokens:4,totalTokens:19}
const cacheUsage: core.Usage = {...legacyUsage,cachedInputTokens:7,cacheWriteInputTokens:0}
// @ts-expect-error cache counters must be numbers
const invalidUsage: core.Usage = {...legacyUsage,cacheWriteInputTokens:'0'}
void invalidUsage
const cacheProvider: core.ModelProvider = {async generate(){return {content:'Cache',toolCalls:[],usage:cacheUsage}}}
const cacheResult: Promise<core.AgentResult> = core.runAgent({provider:cacheProvider,messages:[],tools:[],async executeTool(){return {content:''}},
  onEvent(event: core.AgentEvent){if(event.type === 'round_completed'){
    const read: number | undefined = event.usage?.cachedInputTokens
    const write: number | undefined = event.usage?.cacheWriteInputTokens
    void read; void write
  }}})
void cacheResult.then(result => {
  const read: number | undefined = result.usage.cachedInputTokens
  const write: number | undefined = result.usage.cacheWriteInputTokens
  void read; void write
})
const result: Promise<core.AgentResult> = core.runAgent({ provider, messages: [], tools: [], async executeTool() { return { content: '' } } })
void result
`)
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', 'consumer.cts'], temporary)
  for (const [extension, importLine] of [
    ['mts', "import * as mcp from '@ayayaq/vivi/extensions/mcp'"],
    ['cts', "import mcp = require('@ayayaq/vivi/extensions/mcp')"]
  ]) {
    await writeFile(join(temporary, `mcp-types.${extension}`), `${importLine}
const compiler: mcp.McpSchemaValidator = () => () => {}
const host: mcp.McpExtensionHost = {async captureCatalogs(){return []},prepareOperation(){throw new Error('No connected server')}}
const result = mcp.createMcpExtension(host,[],async () => ({content:''}),{validateSchema:compiler,assertAllowed(){},operationsEnabled:false})
// @ts-expect-error a review callback is mandatory
mcp.createMcpExtension(host,[],undefined,{validateSchema:compiler,assertAllowed(){}})
// @ts-expect-error a privacy callback is mandatory
mcp.createMcpExtension(host,[],async () => ({content:''}),{validateSchema:compiler})
void result
`)
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', `mcp-types.${extension}`], temporary)
  }
  for (const [extension, importLine] of [
    ['mjs', "import * as decisions from '@ayayaq/vivi/decisions'\nimport assert from 'node:assert/strict'"],
    ['cjs', "const decisions = require('@ayayaq/vivi/decisions')\nconst assert = require('node:assert/strict')"]
  ]) {
    await writeFile(join(temporary, `decision-consumer.${extension}`), `${importLine}
;(async () => {
  const snapshot = {sessionId:'package-session',runId:'package-run',toolCall:{id:'call-1',name:'memory_add',arguments:{text:'Tea'}},userRequest:{id:'request-1',text:'Remember tea',approvedScope:{operation:'remember'}},policyRevision:'policy-1',resourceRevisions:{memory:1},inputData:null}
  const request = decisions.createDecisionRequest(snapshot, {provider:'openai',checks:[{name:'scope',instructions:'Matches request?',trueDescription:'Matches',falseDescription:'Outside scope',allowAt:0.95,denyAt:0.05}]})
  const provider = {id:'openai',model:'gpt-6-luna',async evaluate(){return {model:'gpt-6-luna',answers:[{name:'scope',type:'predicate',probability:0.99}],usage:{inputTokens:1,outputTokens:0}}}}
  const result = await decisions.evaluateDecision(request, provider)
  assert.equal(result.outcome, 'allow')
  assert.equal(decisions.isDecisionCurrent(result, snapshot), true)
  assert.equal(decisions.isDecisionCurrent({...result}, snapshot), false)
  assert.equal(typeof decisions.createOpenAIDecisionProvider, 'function')
  assert.equal(typeof decisions.createOpenRouterDecisionProvider, 'function')
  const prepared = {...snapshot,preparedAction:{complete:true,effects:[{kind:'write',resourceId:'memory',scope:'outside-workspace',affectedData:{before:null,after:'Tea'},review:'model-review'}]}}
  const preparedRequest = decisions.createDecisionRequest(prepared, request.policy)
  assert.deepEqual(decisions.routePreparedAction(preparedRequest.snapshot), {route:'model-review',reasonCode:'model_review_required'})
  assert.ok(Object.isFrozen(preparedRequest.snapshot.preparedAction.effects[0]))
  const preparedResult = await decisions.evaluateDecision(preparedRequest, provider)
  assert.equal(decisions.isDecisionCurrent(preparedResult, prepared), true)
  assert.equal(decisions.isDecisionCurrent(preparedResult, {...prepared,preparedAction:{...prepared.preparedAction,complete:false}}), false)
  assert.equal(decisions.routePreparedAction(snapshot).route, 'manual')
})().catch(error => { console.error(error); process.exitCode = 1 })
`)
    run(process.execPath, [`decision-consumer.${extension}`], temporary)
  }
  for (const [extension, importLine] of [
    ['mts', "import * as decisions from '@ayayaq/vivi/decisions'"],
    ['cts', "import decisions = require('@ayayaq/vivi/decisions')"]
  ]) {
    await writeFile(join(temporary, `decision-types.${extension}`), `${importLine}
const snapshot: decisions.DecisionSnapshot = {sessionId:'s',runId:'r',toolCall:{id:'c',name:'memory_add',arguments:{}},userRequest:{id:'u',text:'Remember tea',approvedScope:{}},policyRevision:'p',resourceRevisions:{memory:1},inputData:null}
const request: decisions.DecisionRequest = decisions.createDecisionRequest(snapshot, {provider:'openai',checks:[{name:'scope',instructions:'Matches?',trueDescription:'Matches',falseDescription:'Does not',allowAt:0.95}]})
const effect: decisions.PreparedActionEffect = {kind:'write',resourceId:'memory',scope:'outside-workspace',affectedData:{after:'Tea'},review:'model-review'}
const metadata: decisions.PreparedActionMetadata = {complete:true,effects:[effect]}
const prepared = decisions.createDecisionRequest({...snapshot,preparedAction:metadata}, request.policy)
const route: decisions.PreparedActionRoute = decisions.routePreparedAction(prepared.snapshot)
void route
// @ts-expect-error trusted classification has a closed vocabulary
const invalidEffect: decisions.PreparedActionEffect = {...effect,review:'allow'}
void invalidEffect
// @ts-expect-error captured metadata is immutable
prepared.snapshot.preparedAction!.complete = false
// @ts-expect-error captured effects are immutable
prepared.snapshot.preparedAction!.effects.push(effect)
// @ts-expect-error snapshot is immutable
request.snapshot.runId = 'changed'
// @ts-expect-error explicit provider calibration is required
decisions.createDecisionRequest(snapshot, {provider:'openai',checks:[{name:'scope',instructions:'Matches?',trueDescription:'Matches',falseDescription:'Does not'}]})
// @ts-expect-error requests cannot select authentication destinations
decisions.createOpenAIDecisionProvider({apiKey:'fake',baseURL:'https://example.test'})
// @ts-expect-error generation is a separate protocol
decisions.createOpenRouterDecisionProvider({apiKey:'fake',model:'chat-model'})
const provider: decisions.DecisionProvider = decisions.createOpenAIDecisionProvider({apiKey:async()=> 'fake',timeoutMs:1000,fetch:globalThis.fetch})
const result: Promise<decisions.DecisionResult> = decisions.evaluateDecision(request, provider, {signal:new AbortController().signal})
void result.then(result => { const outcome: decisions.DecisionOutcome = result.outcome; const current: boolean = decisions.isDecisionCurrent(result,snapshot); void outcome;void current })
`)
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext', '--target', 'ES2022', '--lib', 'ES2022,DOM', `decision-types.${extension}`], temporary)
  }
  console.log(`Packaged ESM/CommonJS runtime and TypeScript consumers passed (${packed.filename})`)
  console.log(`sha256 ${sha256}`)
  console.log(`integrity ${packed.integrity}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
