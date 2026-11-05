// Run from the repository root. Generates temporary, non-shipping component fixtures.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const root = process.cwd()
const require = createRequire(`${root}/package.json`)
const { chromium } = require('@playwright/test')
const axe = require('@axe-core/playwright')
const AxeBuilder = axe.default ?? axe
const output = `${root}/docs/evidence/ok-214/unified-login-ui`
const fixture = `${root}/.login-visual-check.local`
const base = '0608659d1c99cf20da2c17cef261c8c87a8b48bc'
const original = (path) => execFileSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8' })
assert.equal(await readFile(`${root}/src/styles.css`, 'utf8'), original('src/styles.css'), 'This comparison assumes unchanged shared CSS.')
await mkdir(fixture) // Refuse to overwrite an existing directory.
let server, browser
try {
  await writeFile(`${fixture}/AuthEntryBefore.tsx`, original('src/auth/AuthEntry.tsx').replace("from './authClient'", "from '../src/auth/authClient'"))
  await writeFile(`${fixture}/index.html`, '<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><base href="/"/><title>OpenKubes login UI verification</title></head><body><div id="root"></div><script type="module" src="/.login-visual-check.local/main.tsx"></script></body></html>')
  await writeFile(`${fixture}/main.tsx`, `
import { createRoot } from 'react-dom/client'
import Before from './AuthEntryBefore'
import After from '../src/auth/AuthEntry'
import type { AuthMode } from '../src/auth/authClient'
import '../src/styles.css'
const params = new URLSearchParams(location.search)
const Entry = params.get('version') === 'before' ? Before : After
createRoot(document.getElementById('root')!).render(<Entry
  authMode={params.get('mode') as AuthMode}
  onAuthenticated={() => { document.body.dataset.previewAuthenticated = 'true' }}
  onStartOidc={() => { document.body.dataset.previewOidcStarted = 'true' }}
  onAuthenticateLocal={async () => { await new Promise(resolve => setTimeout(resolve, 400)); throw new Error('Private fixture failure') }}
/>)
`)
  const port = 5177
  server = spawn(process.execPath, [`${root}/node_modules/vite/bin/vite.js`, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore' })
  server.on('error', () => {})
  const origin = `http://127.0.0.1:${port}`
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error('Fixture server could not start; check port 5177.')
    try { if ((await fetch(`${origin}/.login-visual-check.local/index.html`)).ok) { ready = true; break } } catch { /* bounded startup wait */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ready, 'Fixture server did not become ready.')
  browser = await chromium.launch({ headless: true })
  const results = { before: [], after: [] }
  const interactions = []
  const hash = (value) => createHash('sha256').update(value).digest('hex')
  for (const phase of ['before', 'after']) {
    await mkdir(`${output}/${phase}`, { recursive: true })
    for (const [viewport, size] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
      const context = await browser.newContext({ viewport: size, colorScheme: 'light', reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' })
      for (const mode of ['local', 'prototype', 'oidc', 'bootstrap', 'breakglass']) {
        const page = await context.newPage()
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        const url = `${origin}/.login-visual-check.local/index.html?mode=${mode}&version=${phase}`
        await page.goto(url)
        await page.locator('h1').waitFor()
        await page.evaluate(async () => {
          await document.fonts.ready
          await Promise.all([...document.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => { image.onload = resolve; image.onerror = resolve })))
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })
        await page.screenshot({ path: `${output}/${phase}/${mode}-${viewport}.png`, fullPage: true, animations: 'disabled' })
        const brandingHash = await page.locator('.auth-story').count() ? hash(await page.locator('.auth-story').screenshot({ animations: 'disabled' })) : null
        const dom = await page.locator('main').evaluate(element => element.outerHTML)
        const layout = await page.locator('.auth-card').evaluate(element => { const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] })
        const report = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
        results[phase].push({ mode, viewport, brandingHash, domHash: hash(dom), layout, errors, overflow,
          violations: report.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) })) })
        assert.deepEqual(errors, [])
        assert.equal(overflow, false)
        if (phase === 'after' && mode === 'local') {
          await page.keyboard.press('Tab')
          assert.equal(await page.getByLabel('Username', { exact: true }).evaluate(e => e === document.activeElement), true)
          assert.notEqual(await page.getByLabel('Username').evaluate(e => getComputedStyle(e).boxShadow), 'none')
          await page.keyboard.type('qa-reader')
          await page.keyboard.press('Tab')
          assert.equal(await page.getByLabel('Password', { exact: true }).evaluate(e => e === document.activeElement), true)
          await page.keyboard.type('fixture-only-invalid-password')
          await page.keyboard.press('Tab')
          assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).evaluate(e => e === document.activeElement), true)
          await page.keyboard.press('Enter')
          assert.equal(await page.getByRole('button', { name: 'Signing in…' }).isDisabled(), true)
          await page.getByRole('alert').waitFor()
          assert.equal(await page.getByRole('alert').textContent(), 'Local sign-in could not be completed.')
          assert.equal(await page.getByLabel('Password', { exact: true }).inputValue(), '')
          assert.equal(await page.getByRole('button', { name: 'Sign in', exact: true }).isEnabled(), true)
          const errorAxe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
          assert.deepEqual(errorAxe.violations, [])
          await page.screenshot({ path: `${output}/after/local-error-${viewport}.png`, fullPage: true })
          interactions.push({ mode, viewport, checks: 'keyboard order, visible input focus, Enter submit, pending protection, generic error, password clearing, zero Axe violations in error state', result: 'passed' })
        }
        if (phase === 'after' && ['bootstrap', 'breakglass'].includes(mode)) {
          await page.getByRole('button', { name: /Use a local account/ }).click()
          const submit = page.getByRole('button', { name: 'Authenticate and enter Console' })
          assert.equal(await submit.isDisabled(), true)
          await page.getByLabel('Local username').fill('qa-operator')
          await page.locator('.auth-password input').fill('fixture-only-invalid-password')
          await page.getByLabel(/Operational reason/).fill('Verifying the existing exceptional access boundary')
          assert.equal(await submit.isDisabled(), true)
          await page.getByRole('checkbox').check()
          assert.equal(await submit.isEnabled(), true)
          await submit.click()
          await page.getByRole('alert').waitFor()
          assert.equal(await page.getByRole('alert').textContent(), 'Exceptional local access could not be completed.')
          assert.equal(await page.locator('.auth-password input').inputValue(), '')
          interactions.push({ mode, viewport, checks: 'reason and acknowledgement remain required; generic error and password clearing preserved', result: 'passed' })
        }
        if (phase === 'after' && ['oidc', 'prototype'].includes(mode)) {
          await page.getByRole('button', { name: /Continue with OpenKubes Identity/ }).click()
          if (mode === 'oidc') {
            await page.getByRole('button', { name: 'Continue to identity provider' }).click()
            assert.equal(await page.locator('body').getAttribute('data-preview-oidc-started'), 'true')
          } else {
            await page.getByRole('button', { name: 'Simulate identity provider return' }).click()
            await page.getByRole('button', { name: 'Enter Console' }).click()
            assert.equal(await page.locator('body').getAttribute('data-preview-authenticated'), 'true')
          }
          interactions.push({ mode, viewport, checks: mode === 'oidc' ? 'existing OIDC callback invoked' : 'explicit prototype review/entry preserved', result: 'passed' })
        }
        await page.close()
      }
      await context.close()
    }
    await writeFile(`${output}/${phase}-checks.json`, JSON.stringify(results[phase], null, 2) + '\n')
  }
  for (let index = 0; index < results.before.length; index++) {
    const before = results.before[index], after = results.after[index]
    assert.deepEqual(after.violations, before.violations, `New Axe violation: ${after.mode}/${after.viewport}`)
    if (['oidc', 'prototype'].includes(after.mode)) assert.equal(after.brandingHash, before.brandingHash, 'Branding changed')
    if (after.mode === 'prototype') {
      assert.equal(after.domHash, before.domHash, 'Prototype markup changed')
      assert.deepEqual(after.layout, before.layout, 'Prototype layout changed')
    }
  }
  await writeFile(`${output}/interaction-checks.json`, JSON.stringify(interactions, null, 2) + '\n')
  console.log('PASS: 10 mode/viewport comparisons; unchanged Prototype DOM/layout and OIDC/Prototype branding; no new Axe violations; 10 interaction checks passed.')
} finally {
  await browser?.close()
  if (server && server.exitCode === null && server.signalCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited }
  await rm(fixture, { recursive: true, force: true })
}
