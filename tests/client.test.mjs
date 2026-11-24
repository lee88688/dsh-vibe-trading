/**
 * Client-half contract tests for the composer status chip.
 *
 * `client.js` is a browser bundle: it calls `window.__ModuleLoader__.load` at
 * top level and renders React elements. These tests execute the real file in a
 * vm context with a minimal loader/document/React stand-in, so the half the host
 * actually loads (style injection, slot registration, chip markup) is covered
 * without a browser or a React dependency.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

const CHIP_SLOT = 'conversation.input.left'
const GATE_SLOT = 'conversation.chat.turnTail'
const CONFIG_SLOT = 'plugins.bundle.config'
const STYLE_ID = 'dsh-vibe-trading/status.css'
const SETTINGS_STYLE_ID = 'dsh-vibe-trading/settings.css'
const CONFIG_ENTRY_ID = 'dsh-vibe-trading'

/** The smallest DOM the plugin needs: <style> hosts and their idempotency lookup. */
function fakeDocument() {
  const styles = []
  return {
    styles,
    head: {
      appendChild(node) {
        styles.push(node)
      },
    },
    createElement(tagName) {
      return { tagName, dataset: {}, textContent: '' }
    },
    querySelector(selector) {
      const match = /^style\[data-plugin-css="(.+)"\]$/.exec(selector)
      if (match === null) return null
      return styles.find((style) => style.dataset.pluginCss === match[1]) ?? null
    },
  }
}

/** Style sheet by id (the plugin injects one for the chip and one for the page). */
function styleById(document, id) {
  return document.styles.find((style) => style.dataset.pluginCss === id)
}

/** Minimal `configForms` service plus the write log a test inspects. */
function fakeConfigForms({ status = 'ready', writable = true, value = {} } = {}) {
  const calls = []
  const snapshot = { status, writable, value, revision: 3, base: {}, user: {} }
  const form = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    mutate: (ops) => {
      calls.push(ops)
      return Promise.resolve(true)
    },
  }
  return {
    calls,
    form,
    service: {
      served: true,
      get(entryId) {
        assert.equal(entryId, CONFIG_ENTRY_ID)
        return form
      },
      whileServed(namespaces, register) {
        assert.deepEqual([...namespaces], [CONFIG_ENTRY_ID])
        return register(new Set([CONFIG_ENTRY_ID]))
      },
    },
  }
}

/** Execute client.js the way the host bundle loader does, but inside this process. */
function loadClient({ withDocument = true, configForms = undefined } = {}) {
  const document = withDocument ? fakeDocument() : undefined
  let registration
  const context = vm.createContext({
    console,
    ...(withDocument ? { document } : {}),
    window: {
      __ModuleLoader__: {
        load(definition) {
          registration = definition
        },
      },
    },
  })
  vm.runInContext(source, context, { filename: 'client.js' })
  assert.equal(registration.id, '@monsterlee/dsh-vibe-trading')

  const react = {
    createElement: (type, props, ...children) => {
      // Render function components the way React does so the gate panel's
      // <details> groups are visible to the assertions below.
      if (typeof type === 'function') return type({ ...(props ?? {}), children: children.flat() })
      return { type, props: props ?? {}, children: children.flat() }
    },
    // Enough of the hooks API for a page render: state stays at its initial
    // value and effects do not run, so each call renders one snapshot.
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  }
  const plugin = registration.factory((specifier) => {
    assert.equal(specifier, 'react')
    return react
  })

  const registered = new Map()
  const slots = {
    inject(name, factory) {
      factory()
      return () => {}
    },
    register(meta, component) {
      registered.set(meta.name, { meta, component })
      return () => {}
    },
  }
  const applyContext = (extra = {}) => {
    const ctx = {
      slots,
      ...extra,
      effect(fn) {
        const disposed = fn()
        return typeof disposed === 'function' ? disposed : () => {}
      },
      inject(services, factory) {
        if (services.includes('configForms') && configForms) {
          return factory({ slots, configForms: configForms.service, effect: ctx.effect, inject: ctx.inject })
        }
        return undefined
      },
    }
    return ctx
  }
  return { plugin, document, registered, slots, applyContext, configForms }
}

/** Load and apply the client half, returning everything a test may inspect. */
function mount(options = {}) {
  const harness = loadClient(options)
  harness.plugin.apply(harness.applyContext(options.configForms))
  return harness
}

const projection = (requested) => () => ({ requested, gate: {} })

test('client half registers the composer chip and the per-turn gate footer', () => {
  const { plugin, registered, applyContext } = loadClient()
  // Spread first: the module runs in a vm realm, so its arrays are not cross-realm deep-equal.
  assert.deepEqual([...plugin.inject], ['slots'])
  plugin.apply(applyContext())
  assert.deepEqual([...registered.keys()], [CHIP_SLOT, GATE_SLOT])
  assert.equal(registered.get(CHIP_SLOT).meta.id, 'vibe-trading-status')
  assert.equal(registered.get(GATE_SLOT).meta.id, 'vibe-trading-gate')
})

test('chip stylesheet is injected once and refreshed in place on re-apply', () => {
  const { plugin, document, applyContext } = loadClient()
  plugin.apply(applyContext())
  const first = styleById(document, STYLE_ID)
  plugin.apply(applyContext())

  assert.equal(document.styles.length, 2, 'chip sheet + settings sheet, each once')
  assert.equal(styleById(document, STYLE_ID), first)
  assert.equal(first.tagName, 'style')
  assert.equal(first.dataset.plugin, 'dsh-vibe-trading')
  assert.equal(first.dataset.pluginCss, STYLE_ID)
  assert.ok(styleById(document, SETTINGS_STYLE_ID), 'the settings page ships its own sheet')
})

test('phone-width rule hides the label and keeps the glyph state visible', () => {
  const css = styleById(mount().document, STYLE_ID).textContent
  assert.match(css, /\.dvt-status\s*\{[^}]*display: inline-flex;/)
  assert.match(css, /\.dvt-status\[data-active='true'\] \.dvt-status__glyph\s*\{[^}]*state-success-primary/)
  assert.match(
    css,
    /@media \(max-width: 560px\) \{\s*\.dvt-status \{\s*padding: 0 6px;\s*\}\s*\.dvt-status__label \{\s*display: none;\s*\}\s*\}/,
  )
})

test('active state lights the glyph and names itself for assistive tech', () => {
  const Chip = mount().registered.get(CHIP_SLOT).component
  const tree = Chip({ useProjection: projection('on') })

  assert.equal(tree.type, 'div')
  assert.equal(tree.props.className, 'dvt-status')
  assert.equal(tree.props['data-active'], 'true')
  assert.equal(tree.props.role, 'img')
  assert.equal(tree.props['aria-label'], 'Vibe Trading 已启用')
  assert.match(tree.props.title, /已在本会话启用/)

  const [glyph, label] = tree.children
  assert.equal(glyph.props.className, 'dvt-status__glyph')
  assert.equal(glyph.props['aria-hidden'], true)
  assert.equal(label.props.className, 'dvt-status__label')
  assert.deepEqual(label.children, ['Vibe Trading'])
})

test('inactive and missing projections render the muted, label-named state', () => {
  const Chip = mount().registered.get(CHIP_SLOT).component
  for (const useProjection of [projection('off'), projection(null), undefined]) {
    const tree = Chip(useProjection === undefined ? {} : { useProjection })
    assert.equal(tree.props['data-active'], 'false')
    assert.equal(tree.props['aria-label'], 'Vibe Trading 未启用')
    assert.equal(tree.children[1].children.join(''), 'Vibe Trading')
  }
})

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return Array.isArray(node.children) ? node.children.map(textOf).join('') : ''
}

test('gate footer renders three groups for a turn with panel data', () => {
  const Gate = mount().registered.get(GATE_SLOT).component
  const gate = {
    unverified: 2,
    details: [
      { value: '55.55%', context: '模拟组合的收益率为 55.55%', reason: 'numeric_claim_unavailable' },
      { value: '8.88%', context: '最大回撤为 8.88%。', reason: 'numeric_claim_unavailable' },
    ],
    passed: 0,
    suppressed: 0,
  }
  const tree = Gate({
    turn: { turn: 1, start: undefined },
    seq: 5,
    openFile() {},
    useProjection: () => ({ requested: 'on', gate: { '1': gate } }),
  })
  const text = textOf(tree)
  assert.ok(tree, 'panel must render')
  assert.match(text, /本轮有 2 处数字未通过核实/)
  assert.match(text, /未核实 \/ 未汇报（2）/)
  assert.match(text, /55\.55%/)
  assert.match(text, /模拟组合的收益率为 55\.55%/)
  assert.match(text, /无可用证据/)
  assert.match(text, /已汇报且通过（0）/)
  assert.match(text, /自动豁免（0，无需 report）/)
})

function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}

test('gate footer lays the unverified figures out as a table', () => {
  const Gate = mount().registered.get(GATE_SLOT).component
  const tree = Gate({
    turn: { turn: 4 },
    seq: 7,
    openFile() {},
    useProjection: () => ({
      requested: 'on',
      gate: {
        '4': {
          unverified: 1,
          details: [{ value: '55.55%', context: '收益率为 55.55%', reason: 'numeric_claim_unavailable' }],
        },
      },
    }),
  })
  const scroll = findNode(tree, (node) => node.props?.className === 'dvt-gate__scroll')
  assert.ok(scroll, 'the table sits in a horizontal scroll region')
  assert.equal(scroll.props.role, 'region')
  assert.equal(scroll.props.tabIndex, 0)
  const table = scroll.children[0]
  assert.equal(table.type, 'table')
  assert.equal(table.props.className, 'dvt-gate__table')
  assert.match(textOf(tree), /数字上下文原因/)
  assert.equal(findNode(tree, (node) => node.type === 'th' && node.children[0] === '上下文').children[0], '上下文')
  const reason = findNode(tree, (node) => node.props?.className === 'dvt-gate__reason')
  assert.equal(reason.children[0], '无可用证据')
  assert.equal(reason.props.title, 'numeric_claim_unavailable')
})

test('narrow panels keep one row per figure and scroll horizontally', () => {
  const css = styleById(mount().document, STYLE_ID).textContent
  assert.match(css, /table-layout:\s*fixed/)
  assert.match(css, /\.dvt-gate__scroll \{[^}]*overflow-x:\s*auto/)
  assert.match(css, /@container\s*\(max-width:\s*520px\)/)
  assert.match(css, /@media\s*\(max-width:\s*640px\)/)
  assert.match(css, /width:\s*max-content/)
  assert.match(css, /min-width:\s*100%/)
  assert.match(css, /white-space:\s*nowrap/)
  // One-row layout: the cells must never be turned into stacked blocks.
  assert.doesNotMatch(css, /td\.dvt-gate__context \{\s*display:\s*block/)
})

test('gate footer stays absent for turns without a gate outcome', () => {
  const Gate = mount().registered.get(GATE_SLOT).component
  for (const useProjection of [() => ({ requested: 'on', gate: {} }), undefined]) {
    const tree = Gate({ turn: { turn: 2, start: undefined }, seq: 9, openFile() {}, ...(useProjection ? { useProjection } : {}) })
    assert.equal(tree, null)
  }
})

test('applying without a document (preload) still registers the slots', () => {
  const { plugin, registered, applyContext } = loadClient({ withDocument: false })
  assert.doesNotThrow(() => plugin.apply(applyContext()))
  assert.equal(registered.size, 2, 'no settings service, no config page')
})

/* ------------------------------------------------------------------------- */
/* Profile settings page                                                      */
/* ------------------------------------------------------------------------- */

/** Render the registered settings page against one form snapshot. */
function renderSettingsPage(configForms) {
  const { plugin, registered, applyContext } = loadClient({ configForms })
  plugin.apply(applyContext(configForms))
  const entry = registered.get(CONFIG_SLOT)
  assert.ok(entry, 'the bundle config page is registered once the namespace is served')
  assert.equal(entry.meta.key, CONFIG_ENTRY_ID)
  return entry.component({})
}

test('the settings page registers only while the host serves this row', () => {
  const offline = {
    calls: [],
    service: {
      get: () => {
        throw new Error('must not be read when the namespace is not served')
      },
      whileServed: () => () => {},
    },
  }
  const { plugin, registered, applyContext } = loadClient({ configForms: offline })
  plugin.apply(applyContext(offline))
  assert.equal(registered.has(CONFIG_SLOT), false)
})

test('the settings page renders the gate, skills and worker controls', () => {
  const configForms = fakeConfigForms({
    value: {
      minimumVersion: '0.1.19',
      packageMode: 'pinned',
      verification: { enabled: true, maxRevisions: 2, onFailure: 'disclose' },
      skills: { mode: 'short' },
      worker: { idleMinutes: 30 },
    },
  })
  const tree = renderSettingsPage(configForms)
  const text = textOf(tree)
  assert.match(text, /数字核实门禁/)
  assert.match(text, /启用数字核实门禁/)
  assert.match(text, /identity 门禁/)
  assert.match(text, /修订预算/)
  assert.match(text, /技能目录/)
  assert.match(text, /worker 空闲退出/)
  assert.match(text, /修改后立即生效/)
  // The page explains when each change lands: immediate vs next activation.
  assert.match(text, /不打断进行中的会话/)
  assert.match(text, /下次激活时生效/)
  assert.match(text, /选项不在证据账本里|不在证据账本里/)
})

test('a toggle writes one nested operation for the row setting', async () => {
  const configForms = fakeConfigForms({ value: { verification: { enabled: true } } })
  const tree = renderSettingsPage(configForms)
  const toggle = findNode(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')
  assert.ok(toggle, 'the first control is the gate switch')
  toggle.props.onChange({ target: { checked: false } })
  await Promise.resolve()
  // The module runs in a vm realm; compare plain JSON, not cross-realm arrays.
  assert.deepEqual(JSON.parse(JSON.stringify(configForms.calls[0])), [
    { op: 'set', path: ['verification', 'enabled'], value: false },
  ])
})

test('the page reports an unavailable settings document instead of fake controls', () => {
  const tree = renderSettingsPage(fakeConfigForms({ status: 'unavailable' }))
  assert.match(textOf(tree), /未提供这一行的设置/)
})
