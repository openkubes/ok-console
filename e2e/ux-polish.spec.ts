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
    if (name === 'detail') await page.getByRole('button', { name: 'Open ok-shared' }).click()
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
    await page.goto(`/#/${name}`)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    const launcher = page.locator('.diagnostic-launcher')
    await expect(launcher).toBeInViewport({ ratio: 1 })
    const footer = page.locator('.product-footer')
    await expect(footer).toBeInViewport({ ratio: 1 })
    await disjoint(launcher, footer)
    const target = name === 'overview' ? page.getByRole('button', { name: 'View all clusters' }) : page.locator('.evidence-row').last().locator(':scope > svg').last()
    await disjoint(launcher, target)
    // Vertical clearance protects the footer across its full width, including short copy.
    const box = await launcher.boundingBox()
    const bottom = await footer.boundingBox()
    expect(bottom!.y + bottom!.height).toBeLessThanOrEqual(box!.y - 8)
  }
})
test('U2 BFF Evidence labels wrap at word boundaries without clipping', async ({ page }) => {
  await signInPrototype(page)
  await page.goto('/#/overview')
  const label = page.locator('.evidence-link-label').first()
  await expect(label).toBeVisible()
  expect(await label.evaluate(el => {
    const css = getComputedStyle(el)
    return css.whiteSpace === 'normal' && css.textOverflow !== 'ellipsis' && el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight
  })).toBe(true)
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
  await signInPrototype(page)
  for (const name of ['overview', 'clusters', 'detail', 'detail-mgmt', 'workloads', 'capabilities', 'agents', 'evidence', 'stale-overview']) {
    // Detail selection is local state; a different hash clears it before the next capture.
    if (name.startsWith('detail')) await page.goto('/#/overview')
    if (name === 'stale-overview') await injectBffFailure(page, 'stale')
    await page.goto(`/#/${name.startsWith('detail') ? 'clusters' : name === 'stale-overview' ? 'overview' : name}`)
    if (name === 'detail') await page.getByRole('button', { name: 'Open ok-shared' }).click()
    if (name === 'detail-mgmt') await page.getByRole('button', { name: 'Open ok-mgmt', exact: true }).click()
    await expect(page.locator('h1')).toBeVisible()
    await page.screenshot({ path: `${process.env.UX_CAPTURE_DIR}/${testInfo.project.name}-${name}.png`, fullPage: true })
  }
})
