import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type BrandingE2eTarget = {
  name: string
  port: number
  dir: string | null
  policy: 'fixture-read-only' | null
  config: {
    productName: string
    productShortName?: string
    logo: { file: string; alt: string }
    favicon: string
    colors: { primary: string; accent: string }
    poweredBy?: { name: string }
  } | null
}

const FIRST_PORT = 8811
const EXAMPLE = fileURLToPath(new URL('../../src/branding/test-fixtures/example', import.meta.url))

export const brandingE2eTargets = (): BrandingE2eTarget[] => {
  const dirs = (process.env.OK_CONSOLE_E2E_BRANDING_DIRS ?? EXAMPLE).split(':').filter(Boolean)
  for (const dir of dirs) if (!isAbsolute(dir)) throw new Error(`OK_CONSOLE_E2E_BRANDING_DIRS entries must be absolute: ${dir}`)
  // Branding and deployment policy are independent: the policy-only target proves the lock does not come
  // from branding, and every configured brand runs as an MVP-0 installation with the policy.
  return [
    { name: 'built-in default', port: FIRST_PORT, dir: null, policy: null, config: null },
    { name: 'built-in default + fixture-read-only', port: FIRST_PORT + 1, dir: null, policy: 'fixture-read-only', config: null },
    ...dirs.map((dir, index) => {
      const config = JSON.parse(readFileSync(join(dir, 'branding.json'), 'utf8'))
      return { name: `${config.productName as string} + fixture-read-only`, port: FIRST_PORT + 2 + index, dir, policy: 'fixture-read-only' as const, config }
    }),
  ]
}
