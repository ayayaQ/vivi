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
  run(process.execPath, [join(installed, 'examples/headless.mjs')], temporary)
  assert.equal(manifest.license, 'Apache-2.0')
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0)
  assert.deepEqual(manifest.exports['./providers/models'], {
    import: { types: './dist/providers/models.d.ts', default: './dist/providers/models.js' },
    require: { types: './dist/cjs/providers/models.d.ts', default: './dist/cjs/providers/models.js' }
  })
  assert.deepEqual(await readFile(join(installed, 'LICENSE')), await readFile(join(root, 'LICENSE')))
  assert((await readFile(join(installed, 'LICENSE'), 'utf8')).includes('Version 2.0, January 2004'))
  assert((await readFile(join(installed, 'ATTRIBUTION.md'), 'utf8')).includes('943e3f84f67e4415a899da8921db84639843c625'))
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
  await writeFile(join(temporary, 'consumer.ts'), `
import { runAgent, type AgentEvent, type AgentResult, type HistoryMessage, type JsonObject, type ModelProvider, type ToolCall, type ToolDefinition, type Usage } from '@ayayaq/vivi'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider, type OpenRouterProviderOptions } from '@ayayaq/vivi/providers/openrouter'
import { createToolRegistry, type ToolExtension, type ToolRegistry } from '@ayayaq/vivi/extensions'
import { calculatorExtension, calculate } from '@ayayaq/vivi/extensions/calculator'
import { createMemoryService, createMemoryExtension, decodeMemories, encodeMemories, type MemoryPersistence, type MemoryMutation, type MemoryListResult, type MemoryToolCall } from '@ayayaq/vivi/extensions/memory'
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
  console.log(`Packaged ESM/CommonJS runtime and TypeScript consumers passed (${packed.filename})`)
  console.log(`sha256 ${sha256}`)
  console.log(`integrity ${packed.integrity}`)
} finally {
  await rm(temporary, { recursive: true, force: true })
}
