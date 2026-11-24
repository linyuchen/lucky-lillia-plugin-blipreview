import { describe, expect, it, vi } from 'vitest'
import { Config } from '../src/config.js'

let mockPlugins: any[] | null = []

vi.mock('react', () => ({
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  useEffect: () => {},
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => [initial, () => {}],
}))

vi.mock('@luckylillia-dev/plugin-sdk/webui', () => ({
  SchemaForm: function SchemaForm(props: unknown) { return { kind: 'SchemaForm', props } },
  usePluginContext: () => ({}),
  usePlugins: () => mockPlugins,
  usePluginStatus: () => ({ state: 'active', disabled: false }),
}))

describe('blipreview WebUI AI provider detection', () => {
  it('describes missing, disabled, failed, loading, and active AI provider states', async () => {
    const { describeAiProvider } = await import('../webui/index.js')

    expect(describeAiProvider(null)).toMatchObject({ ready: false })
    expect(describeAiProvider([])).toEqual({
      ready: false,
      message: expect.stringContaining('尚未安装「AI 服务」插件'),
    })
    expect(describeAiProvider([{ name: '@luckylillia-dev/plugin-aiprovider', disabled: true, state: 'disposed' }])).toEqual({
      ready: false,
      message: expect.stringContaining('已停用'),
    })
    expect(describeAiProvider([{ name: '@luckylillia-dev/plugin-aiprovider', disabled: false, state: 'failed', error: 'boom' }])).toEqual({
      ready: false,
      message: expect.stringContaining('启动失败：boom'),
    })
    expect(describeAiProvider([{ name: '@luckylillia-dev/plugin-aiprovider', disabled: false, state: 'loading' }])).toEqual({
      ready: false,
      message: expect.stringContaining('正在启动'),
    })
    expect(describeAiProvider([{ name: '@luckylillia-dev/plugin-aiprovider', disabled: false, state: 'active' }])).toEqual({
      ready: true,
      message: '',
    })
  })

  it('replaces raw model SchemaForm with a friendly notice when AI provider is absent, and restores SchemaForm when active', async () => {
    const mod = await import('../webui/index.js')
    let Editor: any
    mod.default({ config(component: unknown) { Editor = component; return () => {} } } as any)
    expect(typeof Editor).toBe('function')

    const schema = Config.toJSON()
    const value = { ...Config({}), summaryMode: 'llm' as const, model: { ai: 'DeepSeek', model: 'deepseek-flash' } }

    mockPlugins = []
    const withoutProvider = Editor({ value, onChange: () => {}, schema, defaults: {}, errors: {} })
    const modelBranch = withoutProvider.children[1]
    expect(typeof modelBranch.type).toBe('function')
    const noticeSection = modelBranch.type(modelBranch.props)
    expect(noticeSection.type).toBe('section')
    expect(JSON.stringify(noticeSection)).toContain('尚未安装「AI 服务」插件')
    expect(JSON.stringify(noticeSection)).toContain('DeepSeek / deepseek-flash')

    mockPlugins = [{ name: '@luckylillia-dev/plugin-aiprovider', disabled: false, state: 'active' }]
    const withProvider = Editor({ value, onChange: () => {}, schema, defaults: {}, errors: {} })
    const activeBranch = withProvider.children[1].type(withProvider.children[1].props)
    expect(activeBranch.props.fields).toEqual(['model'])
  })
})
