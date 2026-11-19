import { expect, test } from '@playwright/test'
import { browserStorageDump, harness, leaks, openSignIn } from './support'

// The AC7 assertions are "no hits"; this proves each scanned surface can produce a hit.
test('AC7 scanner self-test: a protected value seeded into storage, JS or HttpOnly cookies, or the DOM is reported', async ({ page }) => {
  const sentinel = `ok173-sentinel-${Date.now()}-value`
  await openSignIn(page)
  for (const seed of [
    `localStorage.setItem('seed', '${sentinel}')`,
    `sessionStorage.setItem('seed', '${sentinel}')`,
    `document.cookie = 'seed=${sentinel}; path=/; secure'`,
    `document.body.dataset.seed = '${sentinel}'`,
  ]) {
    expect(leaks(await browserStorageDump(page), [sentinel])).toEqual([])
    await page.evaluate(seed)
    expect(leaks(await browserStorageDump(page), [sentinel])).toHaveLength(1)
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); document.cookie = 'seed=; Max-Age=0; path=/; secure'; delete document.body.dataset.seed })
  }
  await page.context().addCookies([{ name: 'seed', value: sentinel, url: harness().origin, httpOnly: true, secure: true }])
  expect(await page.evaluate(() => document.cookie)).not.toContain('ok173-sentinel')
  expect(leaks(await browserStorageDump(page), [sentinel])).toHaveLength(1)
  expect(leaks(`log line ${harness().clientSecret} end`, [harness().clientSecret])).toHaveLength(1)
})
