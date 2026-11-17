import { immutableEvidenceWorld } from './immutable-evidence'
import { expect, test, type Locator } from '@playwright/test'
import { injectBffFailure, signInPrototype } from './support'

async function disjoint(a: Locator, b: Locator) {
  const first = await a.boundingBox()
  const second = await b.boundingBox()
  expect(first).not.toBeNull()
  expect(second).not.toBeNull()
  const x = Math.min(first!.x + first!.width, second!.x + second!.width) - Math.max(first!.x, second!.x)
  const y = Math.min(first!.y + first!.height, second!.y + second!.height) - Math.max(first!.y, second!.y)
  // Require actual clearance: touching bounding-box edges still intersect.
  expect(x < 0 || y < 0, `elements overlap: ${JSON.stringify({ first, second })}`).toBe(true)
}

test('U1 floating launcher is reachable at load on every primary surface', async ({ page }) => {
  await signInPrototype(page)
  for (const name of ['overview', 'clusters', 'detail', 'workloads', 'capabilities', 'agents', 'evidence', 'create']) {
    await page.goto(`/#/${name === 'detail' ? 'clusters' : name}`)
    if (name === 'detail' || name === 'detail-evidence-dialog') await page.getByRole('button', { name: 'Open ok-shared' }).click()
    await page.evaluate(() => window.scrollTo(0, 0))
    const launcher = page.locator('.diagnostic-launcher')
    await expect(launcher).toBeInViewport({ ratio: 1 })
  }
  await page.locator('.diagnostic-launcher').click()
  await expect(page.getByRole('button', { name: 'Close OK AI Diagnostic' })).toBeInViewport({ ratio: 1 })
  await page.getByRole('button', { name: 'Close OK AI Diagnostic' }).click()
})
test('U1 bottom clearance keeps actions, last Evidence chevron and footer above launcher', async ({ page }) => {
  await signInPrototype(page)
  for (const name of ['overview', 'evidence']) {
    if (name !== 'overview') await page.goto(`/#/${name}`)
    await expect(page.getByRole('heading', { name: name === 'overview' ? 'Hello Arash' : 'Evidence & Audit', exact: true })).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const target = name === 'overview' ? page.getByRole('button', { name: 'View all clusters' }) : page.locator('.evidence-row').last().locator(':scope > svg').last()
    await expect(page.locator('.diagnostic-launcher')).toBeVisible()
    // Scroll and measure in one frame so a later layout/scroll update cannot mix coordinates.
    await expect.poll(() => target.evaluate(el => {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' })
      const launcher = document.querySelector('.diagnostic-launcher')!.getBoundingClientRect()
      const footer = document.querySelector('.product-footer')!.getBoundingClientRect()
      const action = el.getBoundingClientRect()
      const visible = (box: DOMRect) => box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth
      const separate = (a: DOMRect, b: DOMRect) => a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top
      return {
        atBottom: Math.abs(document.documentElement.scrollHeight - innerHeight - scrollY) <= 1,
        launcherVisible: visible(launcher), footerVisible: visible(footer),
        footerClear: separate(launcher, footer), actionClear: separate(launcher, action),
        footerGap: footer.bottom <= launcher.top - 8,
      }
    })).toEqual({ atBottom: true, launcherVisible: true, footerVisible: true, footerClear: true, actionClear: true, footerGap: true })
  }
})
test('U2 BFF dotted Evidence labels fit their buttons and cards', async ({ page }) => {
  const title = 'workers.prod.eu.example.internal.hosting.platform.internal hosting-cluster state'
  await page.route('**/api/console/v0/evidence/*', async route => {
    const response = await route.fetch()
    const body = await response.json()
    if (body.kind === 'EvidenceReference') body.data.title = title
    await route.fulfill({ response, json: body })
  })
  await signInPrototype(page)
  const labels = page.locator('.cluster-card .evidence-link-label')
  await expect(labels.first()).toHaveText(title)
  for (const label of await labels.all()) {
    const edges = await label.evaluate(el => {
      const button = el.closest('button')!
      const card = el.closest('.cluster-card')!
      return { label: el.getBoundingClientRect().right, button: button.getBoundingClientRect().right, card: card.getBoundingClientRect().right }
    })
    expect(edges.label).toBeLessThanOrEqual(edges.button + 1)
    expect(edges.label).toBeLessThanOrEqual(edges.card + 1)
    await expect(label).toHaveCSS('overflow-wrap', 'anywhere')
    await expect(label).toHaveCSS('white-space', 'normal')
    await expect(label).not.toHaveCSS('text-overflow', 'ellipsis')
  }
})
test('B4 compact navigation keeps Sign out clickable and mobile launcher at 16px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-compact', 'Compact navigation only')
  await signInPrototype(page)
  const widget = page.locator('.diagnostic-widget')
  expect(await widget.evaluate(el => getComputedStyle(el).bottom)).toBe('16px')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  await expect(page.locator('.diagnostic-launcher')).toBeHidden()
  await page.getByRole('button', { name: 'Sign out of OpenKubes Console' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome to OpenKubes' })).toBeVisible()
})
test('U9 detail observation pill clears Transition immutable receipt label', async ({ page }) => {
  const close = await immutableEvidenceWorld(page)
  try {
    await signInPrototype(page)
    await page.goto('/#/clusters')
    await page.getByRole('button', { name: 'Open ok-shared', exact: true }).click()
    const card = page.locator('.evidence-card').filter({ hasText: 'Transition' }).first()
    const label = card.locator(':scope > div')
    await expect(label).toContainText('Transition')
    await expect(label).toContainText('Immutable receipt')
    await expect(label.locator('.status')).toContainText('Last observed')
    await disjoint(label.locator('.observation-label'), label.locator('.status'))
    await disjoint(label.locator(':scope > span').first(), label.locator('.observation-label'))
  } finally { await close() }
})
test('G3 observation summary fits the viewport', async ({ page }) => {
  await injectBffFailure(page, 'stale')
  await signInPrototype(page)
  const summary = page.locator('.snapshot')
  const box = await summary.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  expect(await summary.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
})
test('G4 placement chevrons stay beside the placement', async ({ page }) => {
  await signInPrototype(page)
  const rows = page.locator('.activity-row')
  expect(await rows.count()).toBeGreaterThan(0)
  for (const row of await rows.all()) {
    const copy = await row.locator('.activity-copy').boundingBox()
    const chevron = await row.locator(':scope > svg').last().boundingBox()
    expect(chevron!.y).toBeLessThan(copy!.y + copy!.height)
    expect(chevron!.y + chevron!.height).toBeGreaterThan(copy!.y)
  }
})
test('capture c15353 preview page set', async ({ page }, testInfo) => {
  test.skip(!process.env.UX_CAPTURE_DIR, 'Capture only when an artifact directory is requested')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome to OpenKubes' })).toBeVisible()
  await page.screenshot({ path: `${process.env.UX_CAPTURE_DIR}/${testInfo.project.name}-sign-in.png`, fullPage: true })
  await signInPrototype(page)
  for (const name of ['overview', 'clusters', 'detail', 'detail-mgmt', 'detail-evidence-dialog', 'workloads', 'capabilities', 'agents', 'workspaces', 'evidence', 'stale-overview', 'stale-clusters']) {
    // Detail selection is local state; a different hash clears it before the next capture.
    if (name.startsWith('detail')) await page.goto('/#/overview')
    if (name === 'stale-overview') await injectBffFailure(page, 'stale')
    await page.goto(`/#/${name.startsWith('detail') ? 'clusters' : name === 'stale-overview' ? 'overview' : name === 'stale-clusters' ? 'clusters' : name}`)
    if (name === 'detail' || name === 'detail-evidence-dialog') await page.getByRole('button', { name: 'Open ok-shared' }).click()
    if (name === 'detail-mgmt') await page.getByRole('button', { name: 'Open ok-mgmt', exact: true }).click()
    if (name === 'detail-evidence-dialog') {
      await page.locator('.evidence-card').first().click()
      await expect(page.getByRole('dialog')).toBeVisible()
    }
    const heading = name.startsWith('detail') ? name === 'detail-mgmt' ? 'ok-mgmt' : 'ok-shared'
      : name === 'overview' || name === 'stale-overview' ? 'Hello Arash'
      : name === 'clusters' || name === 'stale-clusters' ? 'Clusters'
      : name === 'agents' ? 'AI Agents' : name === 'evidence' ? 'Evidence & Audit'
      : name === 'workspaces' ? 'Developer Workspaces' : name[0].toUpperCase() + name.slice(1)
    await expect(page.locator('h1')).toHaveText(heading)
    await page.evaluate(async () => {
      await document.fonts.ready
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
    })
    await page.screenshot({ path: `${process.env.UX_CAPTURE_DIR}/${testInfo.project.name}-${name}.png`, fullPage: true })
    if (name === 'detail-evidence-dialog') await page.getByRole('button', { name: 'Close evidence' }).click()
  }
})
