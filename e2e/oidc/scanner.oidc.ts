import { expect, test } from '@playwright/test'
import { browserStorageDump, harness, leaks, openSignIn, recordConsoleResponses } from './support'

// The AC7 assertions are "no hits"; this proves each scanned surface can produce a hit.
test('AC7 scanner self-test: a protected value seeded into storage, IndexedDB records, JS or HttpOnly cookies, the DOM or a Console response is reported', async ({ page }) => {
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
  await page.evaluate((value) => new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('seed-db', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('tokens')
    open.onsuccess = () => {
      const tx = open.result.transaction('tokens', 'readwrite')
      tx.objectStore('tokens').put({ token: value }, 'record')
      tx.oncomplete = () => { open.result.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    open.onerror = () => reject(open.error)
  }), sentinel)
  expect(leaks(await browserStorageDump(page), [sentinel])).toHaveLength(1)
  await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.deleteDatabase('seed-db'); r.onsuccess = r.onerror = resolve }))

  const responses = recordConsoleResponses(page)
  await page.route((url) => url.pathname === '/api/console/v0/seed', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: sentinel }) }))
  await page.evaluate((origin) => fetch(`${origin}/api/console/v0/seed`).then((r) => r.text()), harness().origin)
  expect(leaks(await responses(), [sentinel])).toHaveLength(1)

  await page.context().addCookies([{ name: 'seed', value: sentinel, url: harness().origin, httpOnly: true, secure: true }])
  expect(await page.evaluate(() => document.cookie)).not.toContain('ok173-sentinel')
  expect(leaks(await browserStorageDump(page), [sentinel])).toHaveLength(1)
  expect(leaks(`log line ${harness().clientSecret} end`, [harness().clientSecret])).toHaveLength(1)
})
